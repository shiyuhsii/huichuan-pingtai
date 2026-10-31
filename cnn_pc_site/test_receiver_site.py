"""Offline protocol, disk-ACK and queue tests. Never opens a serial device."""
from concurrent.futures import Future
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import zlib

from record_protocol import MAGIC, META, Packet, Parser, command, save_record
from receiver_site import Session, State, SyncQueue, bmp_to_png, prepare_record, select_port
from site_sync import LocalSite, SiteError


def encoded(kind, row=0, payload=b"", *, width=2, height=2, session=9):
    metadata = META.pack(1, kind, 32, 1, session, width, height, row, 96, len(payload), 1, 0, 7, 0x12)
    body = metadata + payload
    return MAGIC + body + struct.pack("<I", zlib.crc32(body))


FRAME = encoded(1) + encoded(2, 0, b"\x0a\0\xff\1") + encoded(2, 1, b"\0\2\xff\0") + encoded(3, 1)


class FakeSerial:
    def __init__(self):
        self.writes = []
        self.in_waiting = 0
    def write(self, data):
        self.writes.append(data)
        return len(data)
    def read(self, count):
        time.sleep(.01)
        return b""


class FakeSite:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []
    def capture(self, metadata, images):
        self.calls.append((metadata, images))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        temp_root = Path(__file__).resolve().parent / ".test-tmp"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.root = Path(self.temp.name)
        assert self.root.resolve().is_relative_to(temp_root.resolve())
        self.output = self.root / "records"
        self.output.mkdir()
        self.state = State(self.output, self.root / "status.json")
        self.device = FakeSerial()
        self.session = Session(self.device, self.output, self.state, "ti60-local-test", threading.Event())
    def tearDown(self):
        self.session.pool.shutdown(wait=True)
        self.temp.cleanup()
    def make_record(self):
        header = Packet(1, 9, 2, 2, 0, 96, 1, 7, 0x12, b"")
        return save_record(self.output, header, b"\x0a\0\xff\1\0\2\xff\0")

    def test_fragmented_valid_frame_is_saved_before_success_ack(self):
        for position in range(0, len(FRAME), 5):
            self.session.consume(FRAME[position:position + 5])
        self.assertTrue(self.state.snapshot()["handshake"])
        self.assertNotIn(command(2, 9), self.device.writes)
        folder = self.session.pending[0].result(timeout=3)
        self.assertTrue((folder / "detection.bmp").is_file())
        self.assertTrue((folder / "record.json").is_file())
        self.assertTrue((folder / "detection.png").is_file())
        self.assertTrue(json.loads((folder / "bridge_manifest.json").read_text(encoding="utf-8"))["complete"])
        self.session.finish_save()
        self.assertIn(command(2, 9), self.device.writes)

    def test_crc_corruption_never_archives_or_success_acks(self):
        bad_row = bytearray(encoded(2, 0, b"\x0a\0\xff\1"))
        bad_row[-1] ^= 1
        self.session.consume(encoded(1) + bad_row + encoded(2, 1, b"\0\2\xff\0") + encoded(3, 1))
        self.assertIsNone(self.session.pending)
        self.assertEqual(list(self.output.glob("*/*/record.json")), [])
        self.assertNotIn(command(2, 9), self.device.writes)
        self.assertIn(command(3, 9), self.device.writes)

    def test_incomplete_frame_never_archives(self):
        self.session.consume(encoded(1) + encoded(2, 0, b"\x0a\0\xff\1") + encoded(3, 1))
        self.assertIsNone(self.session.pending)
        self.assertNotIn(command(2, 9), self.device.writes)
        self.assertEqual(list(self.output.glob("*/*/record.json")), [])

    def test_save_failure_never_success_acks(self):
        future = Future()
        future.set_exception(OSError("disk full"))
        self.session.pending = (future, Packet(1, 9, 2, 2, 0, 96, 1, 7, 0x12, b""))
        self.session.finish_save()
        self.assertNotIn(command(2, 9), self.device.writes)
        self.assertIn(command(3, 9), self.device.writes)

    def test_silent_open_port_and_sent_heartbeat_do_not_mean_connected(self):
        stop = self.session.stop
        timer = threading.Timer(.08, stop.set)
        timer.start()
        self.session.run()
        timer.join()
        self.assertIn(command(1), self.device.writes)
        self.assertFalse(self.state.snapshot()["handshake"])
        self.assertEqual(self.state.snapshot()["connection"], "searching")

    def test_abort_without_begin_does_not_claim_handshake(self):
        self.session.consume(encoded(4))
        self.assertFalse(self.state.snapshot()["handshake"])
        self.assertEqual(self.state.snapshot()["connection"], "searching")

    def test_queue_retry_uses_same_identity_and_does_not_need_new_capture(self):
        self.make_record()
        client = FakeSite([OSError("offline"), {"record": {"id": "record-1"}}])
        queue = SyncQueue(self.output, self.state, "ti60-local-test", client, self.root / "receipts.json")
        with self.assertRaises(OSError):
            queue.sync_one()
        self.assertEqual(queue.receipts, {})
        self.assertTrue(queue.sync_one())
        self.assertEqual(client.calls[0][0], client.calls[1][0])
        self.assertEqual(set(client.calls[1][1]), {"result"})
        self.assertFalse(queue.sync_one())
        restored = SyncQueue(self.output, self.state, "ti60-local-test", client, self.root / "receipts.json")
        self.assertFalse(restored.sync_one())

    def test_deleted_capture_is_not_resurrected_on_retry(self):
        self.make_record()
        client = FakeSite([SiteError("deleted", 410)])
        queue = SyncQueue(self.output, self.state, "ti60-local-test", client, self.root / "receipts.json")
        self.assertTrue(queue.sync_one())
        self.assertFalse(queue.sync_one())
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(next(iter(queue.receipts.values()))["status"], "deleted")

    def test_identity_conflict_is_recorded_and_not_retried(self):
        self.make_record()
        client = FakeSite([SiteError("conflict", 409)])
        queue = SyncQueue(self.output, self.state, "ti60-local-test", client, self.root / "receipts.json")
        queue.sync_one()
        self.assertFalse(queue.sync_one())
        self.assertEqual(self.state.snapshot()["sync"], "error")

    def test_r2_archive_preserves_pixels_and_is_explicitly_a_screenshot(self):
        folder = self.make_record()
        metadata, png = prepare_record(folder, "ti60-local-test")
        self.assertFalse(metadata["originalAvailable"])
        self.assertEqual(metadata["captureKind"], "paired-display")
        self.assertEqual(metadata["boxes"], [])
        self.assertEqual(metadata["scratchCount"], 1)
        self.assertEqual(metadata["boxesSource"], "display-overlay")
        data = bytearray()
        position = 8
        while position < len(png):
            length, = struct.unpack_from(">I", png, position)
            if png[position + 4:position + 8] == b"IDAT":
                data.extend(png[position + 8:position + 8 + length])
            position += length + 12
        self.assertEqual(zlib.decompress(data), b"\0\x0a\x0a\x0a\xff\x20\x20\0\0\xff\xff\xff\xff\xff")

    def test_pre_upgrade_manifest_keeps_exact_metadata_on_retry(self):
        folder = self.make_record()
        metadata, _ = prepare_record(folder, "ti60-local-test")
        legacy = dict(metadata)
        legacy.pop("boxesSource")
        legacy["boxes"] = []
        manifest = folder / "bridge_manifest.json"
        manifest.write_text(json.dumps({"complete": True, "metadata": legacy}), encoding="utf-8")
        retried, _ = prepare_record(folder, "ti60-local-test")
        self.assertEqual(retried, legacy)

    def test_new_archive_has_recoverable_boxes_and_stable_retry(self):
        width, height = 40, 20
        pixels = bytearray(b"\x70\0" * width * height)
        for y in range(5, 15):
            for x in range(4, 14):
                if x in (4, 13) or y in (5, 14):
                    pixels[(y * width + x) * 2 + 1] = 1
                    pixels[(y * width + x + width // 2) * 2 + 1] = 1
        header = Packet(1, 10, width, height, 0, 96, 1, 7, 0x12, b"")
        folder = save_record(self.output, header, pixels)
        metadata, png = prepare_record(folder, "ti60-local-test")
        self.assertEqual(metadata["boxesSource"], "display-overlay")
        self.assertEqual(metadata["boxes"], [{"id": "display-4-5-10-10", "x": .1, "y": .25, "w": .25, "h": .5}])
        repeated, repeated_png = prepare_record(folder, "ti60-local-test")
        self.assertEqual(metadata, repeated)
        self.assertEqual(png, repeated_png)

    def test_synced_legacy_archive_is_not_reuploaded_after_upgrade(self):
        folder = self.make_record()
        path = self.root / "receipts.json"
        path.write_text(json.dumps({str(folder.resolve()): {"status": "synced", "recordId": "kept"}}), encoding="utf-8")
        client = FakeSite([])
        queue = SyncQueue(self.output, self.state, "ti60-local-test", client, path)
        self.assertFalse(queue.sync_one())
        self.assertEqual(client.calls, [])

    def test_incomplete_record_metadata_is_not_queued(self):
        folder = self.make_record()
        path = folder / "record.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["transfer"] = "not verified"
        path.write_text(json.dumps(record), encoding="utf-8")
        client = FakeSite([])
        queue = SyncQueue(self.output, self.state, "ti60-local-test", client, self.root / "receipts.json")
        self.assertFalse(queue.sync_one())
        self.assertEqual(client.calls, [])

    def test_select_port_never_probes_ftdi_or_bluetooth(self):
        ports = [SimpleNamespace(device="COM5", vid=0x0403, pid=0x6014),
                 SimpleNamespace(device="COM3", vid=None, pid=None),
                 SimpleNamespace(device="COM13", vid=0x1a86, pid=0x7523)]
        self.assertEqual(select_port(None, ports)[0], "COM13")
        self.assertIsNone(select_port("COM5", ports)[0])
        ports.append(SimpleNamespace(device="COM14", vid=0x1a86, pid=0x7523))
        self.assertIsNone(select_port(None, ports)[0])


class SitePayloadTests(unittest.TestCase):
    def test_paired_display_upload_contains_only_the_result_file(self):
        class CaptureSite(LocalSite):
            def request(self, path, data=None, content_type="application/json"):
                self.captured = (path, data, content_type)
                return {}
        client = CaptureSite()
        client.capture({"captureKind": "paired-display"}, {"result": b"png"})
        body = client.captured[1]
        self.assertIn(b'name="result"; filename="result.png"', body)
        self.assertNotIn(b'name="original"', body)
        self.assertNotIn(b'name="edges"', body)

    def test_external_upload_destination_is_rejected(self):
        for address in ("https://example.com", "http://example.com", "http://127.0.0.1@evil.example", "http://127.0.0.1/path"):
            with self.assertRaises(ValueError):
                LocalSite(address)


if __name__ == "__main__":
    unittest.main()
