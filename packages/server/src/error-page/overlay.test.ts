import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { overlayError } from './overlay.ts';

/** An error whose stack has one frame at `file`. */
function failing(file: string): Error {
  const error = new Error('boom');
  error.stack = `Error: boom\n    at run (${file}:1:1)`;
  return error;
}

const overlay = (error: Error, root: string) => overlayError(error, root, new Redactor());

describe('the code frame of the overlay', () => {
  it('is read from the app as it is, without redaction', () => {
    const root = tempDir('marmeon-overlay-');
    writeFileSync(join(root, 'page.ts'), 'const password = process.env.X;\n');
    const result = overlay(failing(join(root, 'page.ts')), root);
    expect(result.frame).toContain('const password = process.env.X;');
  });

  it('is not read from a file outside the app, named in the stack or the message', () => {
    const root = tempDir('marmeon-overlay-');
    const outside = tempDir('marmeon-overlay-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'outside-file-content\n');
    const direct = overlay(failing(join(outside, 'secret.txt')), root);
    expect(direct.frame).toBeUndefined();
    expect(JSON.stringify(direct)).not.toContain('outside-file-content');
    const hostile = new Error(`hostile\n    at x (${join(outside, 'secret.txt')}:1:1)`);
    const viaMessage = overlay(hostile, root);
    expect(viaMessage.frame).toBeUndefined();
    expect(JSON.stringify(viaMessage)).not.toContain('outside-file-content');
  });

  it('is not read from .env, nor through a link out of the app', () => {
    const root = tempDir('marmeon-overlay-');
    const outside = tempDir('marmeon-overlay-outside-');
    writeFileSync(join(root, '.env'), 'APP_KEY=env-file-content\n');
    expect(JSON.stringify(overlay(failing(join(root, '.env')), root))).not.toContain('env-file-content');
    writeFileSync(join(outside, 'secret.txt'), 'linked-file-content\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.ts'));
    expect(JSON.stringify(overlay(failing(join(root, 'link.ts')), root))).not.toContain('linked-file-content');
  });

  it('is not read from .env under another case', () => {
    const root = tempDir('marmeon-overlay-');
    writeFileSync(join(root, '.env'), 'APP_KEY=cased-env-content\n');
    expect(JSON.stringify(overlay(failing(join(root, '.ENV')), root))).not.toContain('cased-env-content');
  });

  it('is read from a source file of a dependency outside the app', () => {
    const parent = tempDir('marmeon-overlay-');
    const root = join(parent, 'app');
    mkdirSync(root);
    mkdirSync(join(parent, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', 'dep', 'index.js'), 'throw new Error("dep-source");\n');
    expect(overlay(failing(join(parent, 'node_modules', 'dep', 'index.js')), root).frame).toContain('dep-source');
  });

  it('is not read from a dependency file that is no source, or a .env there', () => {
    const parent = tempDir('marmeon-overlay-');
    const root = join(parent, 'app');
    mkdirSync(root);
    mkdirSync(join(parent, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', 'dep', 'data.json'), '{"k":"json-content"}\n');
    writeFileSync(join(parent, 'node_modules', 'dep', '.env.js'), 'env-in-dep\n');
    expect(JSON.stringify(overlay(failing(join(parent, 'node_modules', 'dep', 'data.json')), root))).not.toContain('json-content');
    expect(JSON.stringify(overlay(failing(join(parent, 'node_modules', 'dep', '.env.js')), root))).not.toContain('env-in-dep');
  });

  it('applies the dependency rule to a node_modules directory inside the app', () => {
    const root = tempDir('marmeon-overlay-');
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'data.json'), '{"k":"inner-json-content"}\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'throw new Error("inner-dep-source");\n');
    expect(JSON.stringify(overlay(failing(join(root, 'node_modules', 'dep', 'data.json')), root))).not.toContain('inner-json-content');
    expect(overlay(failing(join(root, 'node_modules', 'dep', 'index.js')), root).frame).toContain('inner-dep-source');
  });

  it('applies the dependency rule to a NODE_MODULES directory inside the app', () => {
    const root = tempDir('marmeon-overlay-');
    mkdirSync(join(root, 'NODE_MODULES', 'dep'), { recursive: true });
    writeFileSync(join(root, 'NODE_MODULES', 'dep', 'data.json'), '{"k":"upper-json-content"}\n');
    expect(JSON.stringify(overlay(failing(join(root, 'NODE_MODULES', 'dep', 'data.json')), root))).not.toContain('upper-json-content');
  });

  it('is not read through a link in node_modules that leads to a file elsewhere', () => {
    const parent = tempDir('marmeon-overlay-');
    const root = join(parent, 'app');
    mkdirSync(root);
    mkdirSync(join(parent, 'node_modules'));
    writeFileSync(join(parent, 'secret.js'), 'linked-secret\n');
    symlinkSync(join(parent, 'secret.js'), join(parent, 'node_modules', 'x.js'));
    expect(JSON.stringify(overlay(failing(join(parent, 'node_modules', 'x.js')), root))).not.toContain('linked-secret');
  });
});
