import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModuleDefinition } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { unlistedClasses } from './unlisted.ts';

function appWith(files: Record<string, string>): string {
  const root = tempDir('marmeon-unlisted-');
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

const job = (name: string, value: string) => `export class ${name} {\n  static readonly job = '${value}';\n}\n`;
const notification = (name: string, value: string) => `export class ${name} {\n  static readonly notification = '${value}';\n}\n`;
const module = (fields: object) => ({ name: 'billing', ...fields }) as ModuleDefinition;

/** Every file under `root` with its bytes, to prove nothing was written. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = readFileSync(join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

describe('unlistedClasses', () => {
  it('reports nothing for a listed job and a listed notification', () => {
    const root = appWith({ 'modules/billing/jobs/Send.ts': job('SendJob', 'billing.send'), 'modules/billing/notifications/Late.ts': notification('LateNotification', 'billing.late') });
    expect(unlistedClasses(root, [module({ jobs: [{ job: 'billing.send' }], notifications: [{ notification: 'billing.late' }] })])).toEqual([]);
  });

  it('reports an unlisted job with its path', () => {
    const root = appWith({ 'modules/billing/jobs/Send.ts': job('SendJob', 'billing.send') });
    expect(unlistedClasses(root, [module({ jobs: [] })])).toEqual([
      { file: join('modules', 'billing', 'jobs', 'Send.ts'), className: 'SendJob', key: 'job', value: 'billing.send' },
    ]);
  });

  it('reports an unlisted notification', () => {
    const root = appWith({ 'modules/billing/notifications/Late.ts': notification('LateNotification', 'billing.late') });
    expect(unlistedClasses(root, [module({ notifications: [] })]).map((entry) => [entry.className, entry.key])).toEqual([['LateNotification', 'notification']]);
  });

  it('reports a class of a module that is not among the registered ones', () => {
    const root = appWith({ 'modules/other/jobs/Send.ts': job('SendJob', 'other.send') });
    expect(unlistedClasses(root, [module({ jobs: [{ job: 'billing.send' }] })])).toHaveLength(1);
  });

  it('skips tests, type tests, declarations and fixtures', () => {
    const root = appWith({
      'modules/billing/Send.test.ts': job('A', 'x.a'),
      'modules/billing/Send.type-test.ts': job('B', 'x.b'),
      'modules/billing/Send.d.ts': job('C', 'x.c'),
      'modules/billing/__fixtures__/Send.ts': job('D', 'x.d'),
    });
    expect(unlistedClasses(root, [])).toEqual([]);
  });

  it('parses a file and never runs it, and writes nothing', () => {
    const root = appWith({ 'modules/billing/jobs/Send.ts': `throw new Error('executed');\n${job('SendJob', 'billing.send')}` });
    const before = snapshot(root);
    expect(unlistedClasses(root, [])).toHaveLength(1);
    expect(snapshot(root)).toEqual(before);
  });

  it('reads the plain `static job` form too', () => {
    const root = appWith({ 'modules/billing/Send.ts': "export class SendJob {\n  static job = 'billing.send';\n}\n" });
    expect(unlistedClasses(root, [])).toHaveLength(1);
  });

  it('does not follow a symlink out of the app', () => {
    const outside = appWith({ 'Outside.ts': job('OutsideJob', 'x.outside') });
    const root = appWith({ 'modules/billing/.keep': '' });
    symlinkSync(join(outside, 'Outside.ts'), join(root, 'modules/billing/Linked.ts'));
    expect(unlistedClasses(root, [])).toEqual([]);
  });

  it('has nothing to check without a modules directory', () => {
    expect(unlistedClasses(appWith({}), [])).toEqual([]);
  });
});
