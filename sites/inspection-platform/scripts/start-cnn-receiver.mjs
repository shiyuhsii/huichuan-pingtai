// Start the local UART receiver outside the calling terminal's process lifetime.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.resolve(project, '../..');
const entry = path.join(workspace, 'cnn_pc_site', 'receiver_site.py');
const statePath = path.join(project, '.sites-runtime', 'cnn-receiver.json');
const readState = () => {try {return JSON.parse(readFileSync(statePath, 'utf8'));} catch {return null;}};

function owns(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:FPGA_RECEIVER_PID); if($p -and $p.CommandLine -and $p.CommandLine.Contains($env:FPGA_RECEIVER_ENTRY)){[Console]::Write("owned")}'],
    {windowsHide:true, encoding:'utf8', env:{...process.env, FPGA_RECEIVER_PID:String(pid), FPGA_RECEIVER_ENTRY:entry}});
  return result.stdout?.trim() === 'owned';
}

function pythonRuntime() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
  const folders = existsSync(base) ? readdirSync(base).filter(name => /^Python\d+$/.test(name)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true})) : [];
  for (const folder of folders) {
    const exe = path.join(base, folder, 'python.exe');
    const hidden = path.join(base, folder, 'pythonw.exe');
    if (!existsSync(exe) || !existsSync(hidden)) continue;
    const checked = spawnSync(exe, ['-c', 'import sys; assert sys.version_info >= (3,10)'], {windowsHide:true, stdio:'ignore'});
    if (checked.status === 0) return hidden;
  }
  throw new Error('未找到 Python 3.10 或更新版本，CNN 接收服务尚未启动。');
}

export function ensureCnnReceiver(port = 5317) {
  if (process.platform !== 'win32') throw new Error('此后台启动入口仅支持 Windows；其他系统请单独运行 receiver_site.py。');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机平台端口不正确。');
  if (!existsSync(entry)) throw new Error('未找到配套 CNN 接收程序。');
  const previous = readState();
  if (previous && owns(previous.pid)) return {pid:previous.pid, reused:true};
  const code = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$line='"'+$env:FPGA_RECEIVER_PYTHON+'" "'+$env:FPGA_RECEIVER_ENTRY+'" --site-url "'+$env:FPGA_RECEIVER_URL+'"'
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;CurrentDirectory=$env:FPGA_RECEIVER_CWD;ProcessStartupInformation=$startup}|Select-Object ReturnValue,ProcessId|ConvertTo-Json
`;
  const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    windowsHide:true, encoding:'utf8', env:{...process.env, FPGA_RECEIVER_PYTHON:pythonRuntime(),
      FPGA_RECEIVER_ENTRY:entry, FPGA_RECEIVER_URL:`http://127.0.0.1:${port}`, FPGA_RECEIVER_CWD:path.dirname(entry)},
  });
  if (created.status !== 0) throw new Error('CNN 接收服务未启动：'+(created.stderr?.trim() || 'Windows 进程服务不可用'));
  const result = JSON.parse(created.stdout.replace(/^\uFEFF/,''));
  if (result.ReturnValue !== 0 || !Number.isSafeInteger(result.ProcessId)) throw new Error('Windows 未能启动 CNN 接收服务。');
  mkdirSync(path.dirname(statePath), {recursive:true});
  writeFileSync(statePath, JSON.stringify({pid:result.ProcessId, entry, port, startedAt:new Date().toISOString()}));
  return {pid:result.ProcessId, reused:false};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(ensureCnnReceiver(Number(process.argv[2] || 5317))));}
  catch(error) {console.error(error.message); process.exitCode=1;}
}
