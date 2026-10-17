import { writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, Redactor } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { buildReport, parseStack, withSnippets } from './report.ts';

describe('the frames of a report', () => {
  it('are read after the message: a line of the message that looks like a frame is none', async () => {
    const root = tempDir('marmeon-frames-');
    const outside = tempDir('marmeon-frames-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'const leaked = "outside-file-content";\n');
    const app = await createApplication({ root, discover: false, providers: [] }, { env: { NODE_ENV: 'development' } });
    const error = new Error(`hostile\n    at evil (${join(outside, 'secret.ts')}:1:1)`);
    const report = await buildReport({ error, status: 500, request: new Request('http://localhost/x'), requestId: undefined, app, redactor: new Redactor(), solutions: undefined });
    expect(report.frames.some((frame) => frame.file.endsWith('secret.ts'))).toBe(false);
    expect(JSON.stringify(report.frames)).not.toContain('outside-file-content');
  });

  it('stop at 50', () => {
    const stack = Array.from({ length: 80 }, (_, n) => `    at f${n} (/app/file.ts:${n + 1}:1)`).join('\n');
    expect(parseStack(`Error: x\n${stack}`, '/app')).toHaveLength(50);
  });

  it('get no snippet from a file outside the app, or from a link', () => {
    const root = tempDir('marmeon-frames-');
    const outside = tempDir('marmeon-frames-outside-');
    writeFileSync(join(outside, 'a.ts'), 'one\ntwo\n');
    writeFileSync(join(root, 'real.ts'), 'one\ntwo\n');
    symlinkSync(join(outside, 'a.ts'), join(root, 'link.ts'));
    const frame = (file: string) => parseStack(`Error: x\n    at f (${file}:1:1)`, root);
    expect(withSnippets(frame(join(root, 'real.ts')), 1, root)[0]!.snippet).toBeDefined();
    expect(withSnippets(frame(join(outside, 'a.ts')), 1, root)[0]!.snippet).toBeUndefined();
    expect(withSnippets(frame(join(root, 'link.ts')), 1, root)[0]!.snippet).toBeUndefined();
  });

  it('are still found after the error was renamed once its stack was read', async () => {
    const root = tempDir('marmeon-frames-');
    const outside = tempDir('marmeon-frames-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'const leaked = "outside-file-content";\n');
    const app = await createApplication({ root, discover: false, providers: [] }, { env: { NODE_ENV: 'development' } });
    const error = new Error(`hostile\n    at evil (${join(outside, 'secret.ts')}:1:1)`);
    error.name = 'RenamedError';
    const report = await buildReport({ error, status: 500, request: new Request('http://localhost/x'), requestId: undefined, app, redactor: new Redactor(), solutions: undefined });
    expect(report.frames.some((frame) => frame.file.endsWith('secret.ts'))).toBe(false);
    expect(report.frames.length).toBeGreaterThan(0);
  });
});
