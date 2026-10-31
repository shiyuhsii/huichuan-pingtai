// Foreground local-only entry. Ctrl+C closes the server; saved data remains on disk.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let port = 5317;
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (value === '--help' || value === '-h') {
    console.log('Usage: npm run serve -- [--port 5317]');
    console.log('Listens on 127.0.0.1 only. Keep this terminal open; stop with Ctrl+C.');
    process.exit(0);
  }
  const candidate = value === '--port' ? args[++index] : value.startsWith('--port=') ? value.slice(7) : null;
  if (candidate === null || !/^\d+$/.test(candidate ?? '') || Number(candidate) < 1024 || Number(candidate) > 65535) {
    console.error('Only --port <1024..65535> is supported. The server is local-only.');
    process.exit(1);
  }
  port = Number(candidate);
}
if (!existsSync(path.join(root, 'node_modules/vinext/dist/cli.js'))) {
  console.error('Install dependencies first: npm ci');
  process.exit(1);
}
console.log(`Open http://127.0.0.1:${port}/signin-with-chatgpt?return_to=/`);
console.log('This local sign-in is a single-user development session; no ChatGPT account is required.');
const child = spawn(process.execPath, [
  path.join(root, 'scripts/run-framework.mjs'), 'dev', '--hostname', '127.0.0.1', '--port', String(port),
], { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
});
