// Optional foreground receiver. The browser workbench works without FPGA hardware.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = path.join(root, 'cnn_pc_site/receiver_site.py');
const candidates = process.env.FPGA_PYTHON
  ? [[process.env.FPGA_PYTHON, []]]
  : process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
let runtime;
for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, '-c', 'import sys; assert sys.version_info >= (3,10)'],
    { windowsHide: true, stdio: 'ignore' });
  if (result.status === 0) { runtime = { command, prefix }; break; }
}
if (!runtime) {
  console.error('Install Python 3.10+ first, then install cnn_pc_site/requirements.txt with that Python.');
  console.error('You can select a Python executable with the FPGA_PYTHON environment variable.');
  process.exit(1);
}
const child = spawn(runtime.command, [...runtime.prefix, entry, ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1); });
