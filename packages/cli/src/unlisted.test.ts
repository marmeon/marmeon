import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModuleDefinition, ServiceProviderClass } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { unlistedClasses, type UnlistedApp } from './unlisted.ts';

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
/** A provider class with `static jobs`; `jobs` may be any value. */
const provider = (jobs: unknown) => class Provider { static jobs = jobs; } as unknown as ServiceProviderClass;
/** What the check reads of an app: `listed` are the providers its definition lists, `discovered` come from packages. */
const appOf = (modules: ModuleDefinition[], { listed = [], discovered = [] }: { listed?: ServiceProviderClass[]; discovered?: ServiceProviderClass[] } = {}) =>
  ({ modules, providers: [...discovered, ...listed], definition: { root: '/', providers: listed } }) as unknown as UnlistedApp;
/** A real job class, as a package brings it. */
const jobClass = (name: string) => class { static job = name; handle() {} };
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
    expect(unlistedClasses(root, appOf([module({ jobs: [{ job: 'billing.send' }], notifications: [{ notification: 'billing.late' }] })]))).toEqual([]);
  });

  it('reports an unlisted job with its path', () => {
    const root = appWith({ 'modules/billing/jobs/Send.ts': job('SendJob', 'billing.send') });
    expect(unlistedClasses(root, appOf([module({ jobs: [] })]))).toEqual([
      { file: join('modules', 'billing', 'jobs', 'Send.ts'), className: 'SendJob', key: 'job', value: 'billing.send' },
    ]);
  });

  it('reports an unlisted notification', () => {
    const root = appWith({ 'modules/billing/notifications/Late.ts': notification('LateNotification', 'billing.late') });
    expect(unlistedClasses(root, appOf([module({ notifications: [] })])).map((entry) => [entry.className, entry.key])).toEqual([['LateNotification', 'notification']]);
  });

  it('reports a class of a module that is not among the registered ones', () => {
    const root = appWith({ 'modules/other/jobs/Send.ts': job('SendJob', 'other.send') });
    expect(unlistedClasses(root, appOf([module({ jobs: [{ job: 'billing.send' }] })]))).toHaveLength(1);
  });

  it('skips tests, type tests, declarations and fixtures', () => {
    const root = appWith({
      'modules/billing/Send.test.ts': job('A', 'x.a'),
      'modules/billing/Send.type-test.ts': job('B', 'x.b'),
      'modules/billing/Send.d.ts': job('C', 'x.c'),
      'modules/billing/__fixtures__/Send.ts': job('D', 'x.d'),
    });
    expect(unlistedClasses(root, appOf([]))).toEqual([]);
  });

  it('parses a file and never runs it, and writes nothing', () => {
    const root = appWith({ 'modules/billing/jobs/Send.ts': `throw new Error('executed');\n${job('SendJob', 'billing.send')}` });
    const before = snapshot(root);
    expect(unlistedClasses(root, appOf([]))).toHaveLength(1);
    expect(snapshot(root)).toEqual(before);
  });

  it('reads the plain `static job` form too', () => {
    const root = appWith({ 'modules/billing/Send.ts': "export class SendJob {\n  static job = 'billing.send';\n}\n" });
    expect(unlistedClasses(root, appOf([]))).toHaveLength(1);
  });

  it('does not follow a symlink out of the app', () => {
    const outside = appWith({ 'Outside.ts': job('OutsideJob', 'x.outside') });
    const root = appWith({ 'modules/billing/.keep': '' });
    symlinkSync(join(outside, 'Outside.ts'), join(root, 'modules/billing/Linked.ts'));
    expect(unlistedClasses(root, appOf([]))).toEqual([]);
  });

  it('has nothing to check without a modules directory', () => {
    expect(unlistedClasses(appWith({}), appOf([]))).toEqual([]);
  });

  describe('with providers', () => {
    const send = () => appWith({ 'modules/billing/jobs/Send.ts': job('SendJob', 'billing.send') });
    const listsSend = () => provider([jobClass('billing.send')]);

    it('counts a job a provider of the app lists as listed', () => {
      expect(unlistedClasses(send(), appOf([module({ jobs: [] })], { listed: [listsSend()] }))).toEqual([]);
    });

    it('counts a job a provider of a module lists as listed', () => {
      const Provider = listsSend();
      const app = { modules: [module({ providers: [Provider] })], providers: [Provider], definition: { root: '/' } } as unknown as UnlistedApp;
      expect(unlistedClasses(send(), app)).toEqual([]);
    });

    it('counts the provider of a module that gives `providers` as one class, no list', () => {
      const Provider = listsSend();
      const app = { modules: [module({ providers: Provider })], providers: [Provider], definition: { root: '/' } } as unknown as UnlistedApp;
      expect(unlistedClasses(send(), app)).toEqual([]);
    });

    it('does not count a provider that was discovered from a package', () => {
      expect(unlistedClasses(send(), appOf([], { discovered: [listsSend()] }))).toHaveLength(1);
    });

    it('does not count a provider the app lists that is not registered', () => {
      const app = { modules: [], providers: [], definition: { root: '/', providers: [listsSend()] } } as unknown as UnlistedApp;
      expect(unlistedClasses(send(), app)).toHaveLength(1);
    });

    it('still reports a job that no provider and no module lists', () => {
      expect(unlistedClasses(send(), appOf([module({ jobs: [] })], { listed: [provider([jobClass('other.send')])] }))).toHaveLength(1);
    });

    it('reads a static a provider inherits', () => {
      const Child = class extends (listsSend() as unknown as new () => object) {} as unknown as ServiceProviderClass;
      expect(unlistedClasses(send(), appOf([], { listed: [Child] }))).toEqual([]);
    });

    it('never counts a provider for a notification', () => {
      const root = appWith({ 'modules/billing/notifications/Late.ts': notification('LateNotification', 'billing.late') });
      const Notifying = class { static jobs = [jobClass('billing.other')]; static notifications = [{ notification: 'billing.late' }]; } as unknown as ServiceProviderClass;
      const asJob = provider([class { static notification = 'billing.late'; static job = 'billing.late'; }]);
      for (const listed of [[Notifying], [asJob]]) {
        expect(unlistedClasses(root, appOf([], { listed })).map((entry) => [entry.className, entry.key])).toEqual([['LateNotification', 'notification']]);
      }
    });

    it('counts only a class with a string job, and skips a bad value without throwing', () => {
      const root = send();
      const withHole = [jobClass('billing.send'), jobClass('billing.send')];
      Reflect.deleteProperty(withHole, 0);
      const plain = [{ job: 'billing.send' }];
      for (const jobs of [undefined, null, 'billing.send', 42, { job: 'billing.send' }, new Set([jobClass('billing.send')]), plain, [undefined], [null], [() => 1], [jobClass(1 as unknown as string)], ['billing.send']]) {
        expect(unlistedClasses(root, appOf([], { listed: [provider(jobs)] }))).toHaveLength(1);
      }
      expect(unlistedClasses(root, appOf([], { listed: [provider(withHole)] }))).toEqual([]);
      expect(unlistedClasses(root, appOf([], { listed: [provider([null, undefined, jobClass(7 as unknown as string), jobClass('billing.send')])] }))).toEqual([]);
    });
  });

  describe('a module list', () => {
    it('counts a plain object entry and a Set, as the registry takes any iterable', () => {
      const root = appWith({ 'modules/billing/jobs/Send.ts': job('SendJob', 'billing.send'), 'modules/billing/jobs/Mail.ts': job('MailJob', 'billing.mail') });
      expect(unlistedClasses(root, appOf([module({ jobs: [{ job: 'billing.send' }] })]))).toHaveLength(1);
      expect(unlistedClasses(root, appOf([module({ jobs: new Set([{ job: 'billing.send' }, { job: 'billing.mail' }]) })]))).toEqual([]);
    });
  });
});
