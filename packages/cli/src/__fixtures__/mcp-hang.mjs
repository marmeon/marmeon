// Preloaded by a test (NODE_OPTIONS=--import) with MCP_HANG=<file>: the process ignores SIGTERM, stays alive, and starts a process
// that holds its stdout and stderr open and ends only on SIGKILL (its pid goes to the file).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

if (process.env.MCP_HANG) {
  const file = process.env.MCP_HANG;
  const { NODE_OPTIONS: _options, MCP_HANG: _hang, ...env } = process.env;
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env, stdio: 'inherit' });
  writeFileSync(file, String(holder.pid));
}
