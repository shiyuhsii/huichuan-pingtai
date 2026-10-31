// Initialize only this checkout's local SQLite database. No Cloudflare account is used.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configureToolEnvironment } from './tool-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
if (!existsSync(wrangler)) {
  console.error('Install dependencies first: npm ci');
  process.exit(1);
}
configureToolEnvironment(root);
const result = spawnSync(process.execPath, [
  '--import', new URL('./sites-env.mjs', import.meta.url).href, wrangler,
  'd1', 'migrations', 'apply', 'site-creator-d1', '--local',
  '--persist-to', '.wrangler/state', '--config', 'wrangler.local.json',
], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, CI: '1' } });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
