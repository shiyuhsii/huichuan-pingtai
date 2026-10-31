"""B3260012 R2 receiver with a durable local archive and a separate website queue.

The firmware transmits an annotated paired HDMI screenshot, NOT a raw sensor image.
Only a CRC-valid frame is archived; only a durable archive is acknowledged.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import struct
import sys
import threading
import time
import uuid
import zlib

BASE = Path(__file__).resolve().parent
RUNTIME = BASE / ".runtime"
from record_protocol import Parser, Assembler, command, save_record, verify_folder
from site_sync import LocalSite, SiteError, atomic_json
from display_boxes import recover_display_boxes

LOG = logging.getLogger("cnn-site")
_instance_handle = None
_receiver_handle = None


def setup_logging():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    LOG.setLevel(logging.INFO)
    handler = RotatingFileHandler(RUNTIME / "receiver.log", maxBytes=3_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    if sys.stdout is not None:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        LOG.addHandler(console)


def claim_mutex(name):
    if sys.platform != "win32":
        return 1
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(handle)
        return None
    return handle


def claim_instance():
    global _instance_handle
    _instance_handle = claim_mutex("Local\\VF_CNN_LocalSiteBridge")
    return _instance_handle is not None


def claim_receiver():
    global _receiver_handle
    if _receiver_handle is None:
        _receiver_handle = claim_mutex("Local\\VF_CNN_AutoReceiver_B3260012")
    return _receiver_handle is not None


def default_output():
    if os.name == "nt":
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
            value, _ = winreg.QueryValueEx(key, "Desktop")
        desktop = Path(os.path.expandvars(value))
    else:
        desktop = Path.home() / "Desktop"
    return desktop / "FPGA检测记录"


def installation_id():
    path = RUNTIME / "installation.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))["deviceId"]
        if isinstance(value, str) and value.startswith("ti60-local-") and len(value) <= 80:
            return value
    except (OSError, ValueError, KeyError, TypeError):
        pass
    value = "ti60-local-" + uuid.uuid4().hex
    # This identifies this local receiver installation, not a hardware serial number.
    atomic_json(path, {"deviceId": value})
    return value


def png_rgb(width: int, height: int, rgb: bytes):
    if len(rgb) != width * height * 3:
        raise ValueError("PNG像素长度不正确")
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    stride = width * 3
    rows = b"".join(b"\0" + rgb[y * stride:(y + 1) * stride] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def bmp_rgb(data: bytes, width: int, height: int):
    """Read only the exact 24-bit uncompressed BMP layout produced by R2."""
    if not (1 <= width <= 960 and 1 <= height <= 540) or len(data) < 54 or data[:2] != b"BM":
        raise ValueError("检测截图BMP格式不正确")
    length, offset = struct.unpack_from("<I4xI", data, 2)
    dib, w, h, planes, bits, compression = struct.unpack_from("<IiiHHI", data, 14)
    stride = (width * 3 + 3) & ~3
    if (dib, w, h, planes, bits, compression, offset, length) != (40, width, height, 1, 24, 0, 54, len(data)):
        raise ValueError("检测截图BMP头不匹配")
    if len(data) != 54 + stride * height:
        raise ValueError("检测截图BMP不完整")
    rgb = bytearray(width * height * 3)
    for y in range(height):
        row = data[54 + (height - 1 - y) * stride:54 + (height - 1 - y) * stride + width * 3]
        start = y * width * 3
        rgb[start:start + width * 3:3] = row[2::3]
        rgb[start + 1:start + width * 3:3] = row[1::3]
        rgb[start + 2:start + width * 3:3] = row[0::3]
    return bytes(rgb)


def bmp_to_png(data: bytes, width: int, height: int):
    return png_rgb(width, height, bmp_rgb(data, width, height))


def atomic_bytes(path: Path, data: bytes):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def prepare_record(folder: Path, device_id: str):
    """Prepare a stable upload identity; recover only exact screenshot red frames."""
    record = json.loads((folder / "record.json").read_text(encoding="utf-8"))
    if (record.get("firmware") != "B3260012" or record.get("capture") != "frozen_CNN_detection_display"
            or record.get("transfer") != "all rows present; each packet IEEE CRC32 verified"
            or record.get("image") != "detection.bmp"):
        raise ValueError("文件夹不是完整校验过的B3260012截图记录")
    width, height, count = (record.get(k) for k in ("width", "height", "fpga_scratch_count"))
    if (type(width) is not int or type(height) is not int or type(count) is not int
            or not 1 <= count <= 32):
        raise ValueError("记录元数据不正确")
    session = record.get("fpga_session_id")
    frame_id = record.get("record_id")
    if type(session) is not int or not 0 <= session <= 0xffffffff or not isinstance(frame_id, str) or not 1 <= len(frame_id) <= 100:
        raise ValueError("记录会话或帧编号不正确")
    stamp = datetime.fromisoformat(record["received_at"])
    if stamp.tzinfo is None:
        raise ValueError("接收记录时间缺少时区")
    rgb = bmp_rgb((folder / "detection.bmp").read_bytes(), width, height)
    png = png_rgb(width, height, rgb)
    target = folder / "detection.png"
    if not target.exists() or target.read_bytes() != png:
        atomic_bytes(target, png)
    metadata = {
        "version": 1, "source": "fpga-cnn", "deviceId": device_id,
        "sessionId": str(session), "frameId": frame_id,
        "capturedAt": stamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "width": width, "height": height, "build": "B3260012",
        "captureKind": "paired-display", "sourceProtocol": "VFAUTO1",
        "originalAvailable": False, "scratchCount": count, "boxes": [],
        "sha256": {"result": hashlib.sha256(png).hexdigest()}, "resultOriginal": True,
    }
    part_id, batch = record.get("part_id"), record.get("batch")
    if isinstance(part_id, str) and part_id.strip():
        metadata["partId"] = part_id[:100]
    if isinstance(batch, str) and batch.strip():
        metadata["batchId"] = batch[:100]
    # A pre-upgrade manifest may already have reached the website before the
    # local receipt was written. Keep its exact old payload on retry; otherwise
    # changing boxes would conflict with that immutable capture identity.
    manifest_path = folder / "bridge_manifest.json"
    try:
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        previous = None
    legacy_payload = (isinstance(previous, dict) and previous.get("complete") is True
                      and previous.get("metadata") == metadata)
    if not legacy_payload:
        metadata["boxesSource"] = "display-overlay"
        metadata["boxes"] = recover_display_boxes(width, height, rgb, max_boxes=count)
    atomic_json(folder / "bridge_manifest.json", {"complete": True, "metadata": metadata,
                "image": "detection.png", "image_note": record.get("image_note", ""),
                "timestampSource": "PC received time; not a sensor timestamp",
                "boxes_note": "Selectable rectangles recovered from the left screenshot red overlay; not independent model coordinates"})
    return metadata, png


class State:
    def __init__(self, output: Path, path: Path | None = None):
        self.lock = threading.RLock()
        self.last_write = 0.0
        self.path = path or RUNTIME / "status.json"
        self.data = {"connection": "searching", "handshake": False, "port": "", "build": "B3260012",
                     "message": "正在查找板载CH340串口。", "progress": 0, "archivePath": str(output),
                     "sync": "idle", "lastCaptureId": "", "bytesReceived": 0, "packetsReceived": 0,
                     "readyHeartbeatsSent": 0, "lastVerifiedAt": None, "pid": os.getpid()}
        self.update()

    def update(self, **values):
        with self.lock:
            previous = self.data.get("message")
            important_change = any(self.data.get(name) != value for name, value in values.items()
                                   if name in ("connection", "message", "sync", "archivePath"))
            self.data.update(values)
            self.data["updatedAt"] = datetime.now(timezone.utc).isoformat()
            if important_change or time.monotonic() - self.last_write >= .25:
                try:
                    atomic_json(self.path, self.data)
                    self.last_write = time.monotonic()
                except OSError as exc:
                    LOG.warning("状态文件暂未写入：%s", exc)
            if values.get("message") and values["message"] != previous:
                LOG.info(values["message"])

    def snapshot(self):
        with self.lock:
            return dict(self.data)

    def site_status(self):
        data = self.snapshot()
        names = ("connection", "handshake", "port", "build", "message", "progress", "archivePath", "sync", "lastCaptureId")
        return {name: data[name] for name in names}


class SyncQueue:
    def __init__(self, output: Path, state: State, device_id: str, client: LocalSite,
                 path: Path | None = None):
        self.output, self.state, self.device_id, self.client = output, state, device_id, client
        self.path = path or RUNTIME / "sync_receipts.json"
        try:
            self.receipts = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(self.receipts, dict):
                self.receipts = {}
        except (OSError, ValueError):
            self.receipts = {}
        self.invalid = set()

    def sync_one(self):
        for record_path in sorted(self.output.glob("*/*/record.json")):
            folder = record_path.parent
            identity = str(folder.resolve())
            if folder.name.startswith(".") or identity in self.receipts or identity in self.invalid:
                continue
            try:
                metadata, png = prepare_record(folder, self.device_id)
            except (ValueError, KeyError, TypeError) as exc:
                LOG.warning("跳过不完整或不支持的归档 %s：%s", folder, exc)
                self.invalid.add(identity)
                continue
            self.state.update(sync="pending", archivePath=str(folder))
            try:
                result = self.client.capture(metadata, {"result": png})
            except SiteError as exc:
                if exc.status in (409, 410):
                    status = "deleted" if exc.status == 410 else "conflict"
                    self.receipts[identity] = {"status": status, "message": str(exc)}
                    atomic_json(self.path, self.receipts)
                    self.state.update(sync="error" if exc.status == 409 else "idle")
                    LOG.warning("归档同步停止重试 %s：%s", folder, exc)
                    return True
                raise
            record_id = result.get("record", {}).get("id", "")
            self.receipts[identity] = {"status": "synced", "recordId": record_id,
                                       "sha256": metadata["sha256"]["result"]}
            atomic_json(self.path, self.receipts)
            self.state.update(sync="synced", lastCaptureId=record_id, archivePath=str(folder))
            LOG.info("检测截图已导入本机工作台：%s", record_id)
            return True
        return False


class Session:
    def __init__(self, device, output: Path, state: State, device_id: str, stop: threading.Event):
        self.device, self.output, self.state, self.device_id, self.stop = device, output, state, device_id, stop
        self.parser, self.frames = Parser(), Assembler()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cnn-disk")
        self.pending = None
        self.last_packet = time.monotonic()

    def write(self, opcode, session=0):
        data = command(opcode, session)
        if self.device.write(data) != len(data):
            raise OSError("串口命令未完整发送")

    def save(self, packet, pixels):
        folder = save_record(self.output, packet, pixels)
        prepare_record(folder, self.device_id)
        return folder

    def finish_save(self):
        if self.pending is None or not self.pending[0].done():
            return
        future, packet = self.pending
        self.pending = None
        try:
            folder = future.result()
        except Exception as exc:
            self.write(3, packet.session)
            self.state.update(connection="error", message="图片保存未完成，请检查磁盘空间后重新冻结。", progress=0)
            LOG.exception("本机保存失败：%s", exc)
            return
        self.write(2, packet.session)
        self.state.update(connection="connected", handshake=True, progress=100,
                          archivePath=str(folder), sync="pending",
                          message="检测截图已完整校验并保存，正在导入本机工作台。")
        LOG.info("已保存并向板子确认：%s", folder)

    def consume(self, data: bytes):
        before = self.parser.bad_packets
        packets = self.parser.feed(data)
        if self.parser.bad_packets != before:
            if self.frames.start:
                self.write(3, self.frames.start.session)
            self.frames.reset()
            self.state.update(connection="error", progress=0,
                              message="串口数据校验失败，本次不保存，请重新冻结检测。")
        current = self.state.snapshot()
        self.state.update(bytesReceived=current["bytesReceived"] + len(data))
        for packet in packets:
            self.last_packet = time.monotonic()
            try:
                if packet.firmware != 0x12 or packet.threshold > 2047:
                    raise ValueError("固件版本或阈值不匹配")
                if self.pending is not None:
                    raise ValueError("上一帧仍在保存")
                complete = self.frames.accept(packet)
                current = self.state.snapshot()
                updates = {"packetsReceived": current["packetsReceived"] + 1,
                           "lastVerifiedAt": datetime.now(timezone.utc).isoformat()}
                if packet.kind == 1:
                    updates.update(connection="receiving", handshake=True, progress=0,
                                   message=f"已收到CNN检测，候选划痕{packet.count}处，正在接收截图。")
                elif packet.kind == 2:
                    updates.update(connection="receiving", handshake=True,
                                   progress=round(100 * (packet.row + 1) / packet.height, 1))
                elif packet.kind == 4:
                    updates.update(connection="connected" if current["handshake"] else "searching", progress=0,
                                   message="板子取消了本次回传；请保持冻结并重新检测。")
                self.state.update(**updates)
                if complete:
                    header, pixels = complete
                    self.pending = (self.pool.submit(self.save, header, pixels), header)
                    self.state.update(message="截图已接收完整，正在写入本机磁盘。")
            except ValueError as exc:
                self.frames.reset()
                self.write(3, packet.session)
                self.state.update(connection="error", progress=0,
                                  message="本次回传不完整或格式不匹配，请重新冻结检测。")
                LOG.warning("无效回传：%s", exc)

    def run(self):
        last_hb, last_stats = 0.0, 0.0
        self.state.update(connection="searching", handshake=False, progress=0,
                          message="串口已打开，正在发送R2就绪心跳。请确认HDMI为PC READY，再重新冻结有划痕的画面。")
        try:
            while not self.stop.is_set():
                now = time.monotonic()
                if now - last_hb >= .5:
                    self.write(1)
                    snapshot = self.state.snapshot()
                    # The count is diagnostic only, not a board acknowledgement.
                    self.state.update(readyHeartbeatsSent=snapshot["readyHeartbeatsSent"] + 1)
                    last_hb = now
                data = self.device.read(min(max(self.device.in_waiting, 1), 8192))
                if data:
                    self.consume(data)
                self.finish_save()
                if self.frames.start and time.monotonic() - self.last_packet > 4:
                    self.write(3, self.frames.start.session)
                    self.frames.reset()
                    self.parser = Parser()
                    self.state.update(connection="error", progress=0,
                                      message="回传中断，本次不归档，请重新冻结检测。")
                if now - last_stats > 3:
                    self.state.update()
                    last_stats = now
        finally:
            try:
                self.write(4)
            except OSError:
                pass
            # A fully received frame may finish saving even if USB is removed.
            self.pool.shutdown(wait=True)


def select_port(configured, ports):
    candidates = [p for p in ports if p.vid == 0x1a86 and p.pid in (0x7523, 0x5523)]
    if configured:
        selected = next((p for p in candidates if p.device.upper() == configured.upper()), None)
        return (selected.device, "") if selected else (None, "等待指定的CH340串口出现：" + configured)
    if len(candidates) == 1:
        return candidates[0].device, ""
    if len(candidates) > 1:
        return None, "发现多个CH340设备，请指定板子对应串口后启动。"
    return None, "尚未发现板载CH340串口，请接好UART数据线。"


def heartbeat_worker(site_url, state, stop):
    client = LocalSite(site_url)
    previous = None
    while not stop.is_set():
        try:
            client.status(state.site_status())
            previous = None
        except Exception as exc:
            if str(exc) != previous:
                LOG.warning("工作台状态同步等待重试：%s", exc)
                previous = str(exc)
        stop.wait(3)


def upload_worker(site_url, output, state, device_id, stop):
    queue = SyncQueue(output, state, device_id, LocalSite(site_url))
    while not stop.is_set():
        try:
            did_work = queue.sync_one()
            stop.wait(.2 if did_work else 2)
        except Exception as exc:
            state.update(sync="error")
            LOG.warning("本机归档保留，网站导入稍后重试：%s", exc)
            stop.wait(5)


def main():
    parser = argparse.ArgumentParser(description="B3260012 CNN本机网站接收桥")
    parser.add_argument("--site-url", default="http://127.0.0.1:5317")
    parser.add_argument("--port", help="指定CH340 COM口；默认自动查找唯一CH340")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--probe-seconds", type=float, default=0)
    args = parser.parse_args()
    setup_logging()
    LocalSite(args.site_url)  # Reject non-loopback URLs before touching the serial port.
    if not claim_instance():
        LOG.info("本机网站接收桥已经运行；未重复启动。")
        return
    try:
        import serial
        from serial.tools import list_ports
    except ImportError:
        raise SystemExit(
            "Missing pyserial. Run your Python with: -m pip install -r cnn_pc_site/requirements.txt"
        ) from None
    output = (args.output or default_output()).expanduser().resolve()
    verify_folder(output)
    state = State(output)
    device_id = installation_id()
    stop = threading.Event()
    if args.probe_seconds > 0:
        timer = threading.Timer(args.probe_seconds, stop.set)
        timer.daemon = True
        timer.start()
    workers = [threading.Thread(target=heartbeat_worker, args=(args.site_url, state, stop), daemon=True),
               threading.Thread(target=upload_worker, args=(args.site_url, output, state, device_id, stop), daemon=True)]
    for worker in workers:
        worker.start()
    LOG.info("B3260012本机接收桥启动，PID=%s，保存目录：%s", os.getpid(), output)
    try:
        while not stop.is_set():
            try:
                if not claim_receiver():
                    state.update(connection="searching", handshake=False, port="", progress=0,
                                 message="原版R2接收器正在运行，网站正在观察完整归档。板子连接状态请查看原版窗口或HDMI。")
                    stop.wait(3)
                    continue
                port, message = select_port(args.port, list(list_ports.comports()))
                if not port:
                    state.update(connection="disconnected", handshake=False, port="", progress=0, message=message)
                    stop.wait(1)
                    continue
                state.update(port=port, handshake=False)
                device = serial.Serial(port=None, baudrate=460800, timeout=.05,
                                       write_timeout=.5, rtscts=False, dsrdtr=False)
                device.dtr = False
                device.rts = False
                device.port = port
                try:
                    device.open()
                    device.reset_input_buffer()
                    Session(device, output, state, device_id, stop).run()
                finally:
                    device.close()
            except (OSError, serial.SerialException) as exc:
                state.update(connection="error", handshake=False, progress=0,
                             message="串口暂不可用，请检查端口占用与UART连接，接收器会自动重试。")
                LOG.warning("串口连接等待重试：%s", exc)
                stop.wait(3)
    finally:
        stop.set()
        state.update(connection="disconnected", handshake=False, message="本机接收服务已停止。")
        # Best-effort shutdown notification; queued images stay on disk.
        try:
            LocalSite(args.site_url).status(state.site_status())
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        LOG.info("接收服务已停止。")
    except Exception:
        if not LOG.handlers:
            setup_logging()
        LOG.exception("接收桥启动或运行失败")
        sys.exit(1)
