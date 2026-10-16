import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { repo } from './__fixtures__/cli.js';

/**
 * Where NODE_ENV comes from: the process's, else the app's `.env` — what a developer's machine has (`NODE_ENV=development`
 * from `.env.example`). A copy of the blank app with a `.env` of its own; the commands run without a NODE_ENV of the process.
 */
describe('marmeon dev: its companions', { timeout: 30_000 }, () => {
  let app: string;

  beforeAll(() => {
    // An app with a long-running command — what `marmeon dev` runs beside the server (the queue worker): it stops on SIGTERM.
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-companion-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@marmeon/core': '*', marmeon: '*' } }));
    mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
    symlinkSync(join(repo, 'packages/core'), join(app, 'node_modules/@marmeon/core'), 'dir');
    symlinkSync(join(repo, 'packages/cli'), join(app, 'node_modules/marmeon'), 'dir');
    mkdirSync(join(app, 'bootstrap'));
    writeFileSync(
      join(app, 'bootstrap/app.ts'),
      [
        "import { join } from 'node:path';",
        "import { defineApplication, defineModule } from '@marmeon/core';",
        'class WaitCommand {',
        "  static command = 'wait';",
        "  static description = 'Wait for SIGTERM';",
        '  async handle({ output }: { output: { line(text: string): void } }) {',
        "    const stopped = new Promise((resolve) => process.on('SIGTERM', resolve));",
        '    const alive = setInterval(() => {}, 1000);',
        '    output.line(`waiting ${process.pid}`);',
        '    await stopped;',
        '    clearInterval(alive);',
        '    output.line(`stopped by SIGTERM ${process.pid}`);',
        '    return 0;',
        '  }',
        '}',
        "export default defineApplication({ root: join(import.meta.dirname, '..'), modules: [defineModule({ name: 'waiting', commands: [WaitCommand] })] });",
        '',
      ].join('\n'),
    );
    // What `serve` does for each companion (startMarmeon) — in a process the test then kills.
    writeFileSync(
      join(app, 'server.mjs'),
      `import { startMarmeon } from ${JSON.stringify(join(repo, 'packages/cli/src/spawn.ts'))};\nconst child = startMarmeon(process.cwd(), ['wait']);\nconsole.log('companion ' + child.pid);\nsetInterval(() => {}, 1000);\n`,
    );
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('a companion stops by itself — as on SIGTERM — when its server ends without stopping it (killed, crashed)', async () => {
    // Its own process group, so that the test sees every process of the tree by PID — and ends what is left of it.
    const { MARMEON_CHILD: _child, NODE_OPTIONS: _options, ...parent } = process.env;
    const server = spawn(process.execPath, [join(app, 'server.mjs')], { cwd: app, detached: true, env: { ...parent, NODE_ENV: 'development', NO_COLOR: '1', APP_KEY: `base64:${Buffer.alloc(32, 4).toString('base64')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    server.stdout.on('data', (chunk) => (output += chunk));
    server.stderr.on('data', (chunk) => (output += chunk));
    const group = () =>
      spawnSync('ps', ['-o', 'pid=', '-g', String(server.pid)], { encoding: 'utf8' })
        .stdout.trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    onTestFinished(() => {
      for (const pid of group()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ended meanwhile
        }
      }
    });
    const deadline = Date.now() + 20_000;
    while (!/waiting \d+/.test(output)) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`the companion did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The server, the companion's launcher and — in the monorepo — the launcher's Node with the source condition.
    expect(group().length, output).toBeGreaterThanOrEqual(2);
    process.kill(server.pid!, 'SIGKILL'); // the server ends without any shutdown
    const until = Date.now() + 15_000;
    while (group().length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(group(), `left running after its server was killed:\n${output}`).toEqual([]);
    // It ran its own shutdown — the command saw SIGTERM —, it was not killed.
    expect(output).toMatch(/stopped by SIGTERM \d+/);
  }, 40_000);
});
