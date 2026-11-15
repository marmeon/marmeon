import { createHttpKernel } from '@marmeon/server';
import { createApplication, defineModule, listen, type Container, type ServiceProvider } from '@marmeon/core';
import { generateKey } from '@marmeon/encryption';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { GuardSlotsCheck } from './guard-slot-check.ts';
import { defineGuard } from './define-guard.ts';
import { defineGuardSlot } from './guard-slot.ts';
import { SignedIn } from './events.ts';
import { AuthServiceProvider } from './index.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { MemoryUsers } from './test-helpers/users.ts';
import { CacheServiceProvider } from '@marmeon/cache';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';

interface EditorUser {
  readonly id: number;
}

class Users extends MemoryUsers<EditorUser> {}
const Office = defineGuard('office', { users: Users, tablePrefix: 'office_' });
const Ghost = defineGuard('ghost', { users: Users, tablePrefix: 'ghost_' });
const Editor = defineGuardSlot<EditorUser>('editor');
const Other = defineGuardSlot<EditorUser>('other');
// A second slot of the same name: told apart by the object.
const EditorTwin = defineGuardSlot<EditorUser>('editor');

class RecordEditorSignIn {
  handle(): void {}
}
class RecordOtherSignIn {
  handle(): void {}
}

/** Where the test's package binds its slots: nothing, the register() of its provider, or a boot() after the auth provider's. */
let binding: (container: Container, phase: 'register' | 'boot') => void = () => {};

class PackageProvider implements ServiceProvider {
  register(container: Container): void {
    Office.register(container);
    binding(container, 'register');
  }
}
class LateProvider implements ServiceProvider {
  boot({ container }: { container: Container }): void {
    binding(container, 'boot');
  }
}

afterEach(() => {
  binding = () => {};
});

async function bootedApp(listeners: ReturnType<typeof listen>[]) {
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-guard-slot-check-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, PackageProvider, AuthServiceProvider, LateProvider],
      modules: [defineModule({ name: 'guard-slot-check-test', listeners })],
    },
    { env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' } },
  );
  onTestFinished(() => application.shutdown());
  return application;
}

async function booted(listeners: ReturnType<typeof listen>[]) {
  return (await bootedApp(listeners)).container.make(GuardSlotsCheck).handle();
}

const editorListener = () => listen(Editor.events.SignedIn, RecordEditorSignIn as never);

describe('the guard-slots check', () => {
  it('is named like a check of a package and runs on the booted app', () => {
    expect(GuardSlotsCheck.check).toBe('guard-slots');
    expect(GuardSlotsCheck.check).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(GuardSlotsCheck.phase).toBe('run');
    expect(AuthServiceProvider.checks).toContain(GuardSlotsCheck);
  });

  it('reports one A8 error that names an unbound slot and its listener', async () => {
    const problems = await booted([editorListener()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', code: 'A8' });
    expect(problems[0]!.message).toContain("'editor'");
    expect(problems[0]!.message).toContain('RecordEditorSignIn');
    expect(problems[0]!.message).toContain('never dispatched');
  });

  it('names the listeners of one slot together, an anonymous one as such', async () => {
    const problems = await booted([editorListener(), listen(Editor.events.SignedOut, RecordEditorSignIn as never), listen(Editor.events.PasswordChanged, (() => {}) as never)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('(RecordEditorSignIn, RecordEditorSignIn, (anonymous))');
  });

  it('never puts a listener name that is no string into a message: a static name that is a function or a symbol reads as anonymous', async () => {
    const secret = 'SECRET-SOURCE-TEXT';
    class Odd {
      static name = (() => secret) as unknown as string;
    }
    class Symbolic {
      static name = Symbol('hidden') as unknown as string;
    }
    const problems = await booted([listen(Editor.events.SignedIn, Odd as never), listen(Editor.events.SignedOut, Symbolic as never)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('((anonymous), (anonymous))');
    expect(problems[0]!.message).not.toContain(secret);
  });

  it('skips a listener of an ordinary event without throwing, next to the listener of an unbound slot', async () => {
    const problems = await booted([listen(SignedIn, RecordOtherSignIn as never), editorListener()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('(RecordEditorSignIn)');
    expect(problems[0]!.message).not.toContain('RecordOtherSignIn');
  });

  it('reports a slot that a provider booting after the auth provider bound to a guard nobody registered', async () => {
    binding = (container, phase) => phase === 'boot' && Editor.bind(container, Ghost);
    const problems = await booted([editorListener()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', code: 'A8' });
    expect(problems[0]!.message).toContain("'ghost'");
    expect(problems[0]!.message).toContain('RecordEditorSignIn');
  });

  it('gives no finding for a slot bound in the register() of a provider', async () => {
    binding = (container, phase) => phase === 'register' && Editor.bind(container, Office);
    expect(await booted([editorListener()])).toEqual([]);
  });

  it('gives no finding for a slot bound in the boot() of a provider that boots after the auth provider', async () => {
    binding = (container, phase) => phase === 'boot' && Editor.bind(container, Office);
    expect(await booted([editorListener()])).toEqual([]);
  });

  it("gives no finding for a slot bound to 'web'", async () => {
    binding = (container, phase) => phase === 'register' && Editor.bind(container, 'web');
    expect(await booted([editorListener()])).toEqual([]);
  });

  it('gives no finding when no slot has a listener, bound or not', async () => {
    expect(await booted([])).toEqual([]);
  });

  it('reports only the unbound slot of two that have listeners', async () => {
    binding = (container, phase) => phase === 'register' && Editor.bind(container, 'web');
    const problems = await booted([editorListener(), listen(Other.events.SignedIn, RecordOtherSignIn as never)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("'other'");
    expect(problems[0]!.message).toContain('RecordOtherSignIn');
  });

  it('reports two unbound slots of the same name twice, and a bound twin not at all', async () => {
    const both = [editorListener(), listen(EditorTwin.events.SignedIn, RecordOtherSignIn as never)];
    expect(await booted(both)).toHaveLength(2);
    binding = (container, phase) => phase === 'register' && EditorTwin.bind(container, 'web');
    const problems = await booted(both);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('RecordEditorSignIn');
  });

  describe('at the start of the app', () => {
    it('refuses an unbound slot that has a listener, with the same A8 text as the check', async () => {
      const application = await bootedApp([editorListener()]);
      const [problem] = application.container.make(GuardSlotsCheck).handle();
      expect(() => createHttpKernel(application)).toThrow(/\[marmeon:A8\] The guard slot 'editor' has listeners \(RecordEditorSignIn\) but is not bound/);
      expect(problem!.message).toContain("'editor' has listeners (RecordEditorSignIn)");
    });

    it('refuses a slot that a provider booting after the auth provider bound to a guard nobody registered', async () => {
      binding = (container, phase) => phase === 'boot' && Editor.bind(container, Ghost);
      const application = await bootedApp([editorListener()]);
      expect(() => createHttpKernel(application)).toThrow(/A8.*ghost.*RecordEditorSignIn/s);
    });

    it('starts when a provider bound the slot in a boot() after the auth provider, or in register()', async () => {
      binding = (container, phase) => phase === 'boot' && Editor.bind(container, Office);
      const inBoot = await bootedApp([editorListener()]);
      expect(() => createHttpKernel(inBoot)).not.toThrow();
      binding = (container, phase) => phase === 'register' && Editor.bind(container, 'web');
      const bound = await bootedApp([editorListener()]);
      expect(() => createHttpKernel(bound)).not.toThrow();
    });

    it('starts without slot listeners, and with an ordinary listener', async () => {
      const none = await bootedApp([]);
      expect(() => createHttpKernel(none)).not.toThrow();
      const ordinary = await bootedApp([listen(SignedIn, RecordOtherSignIn as never)]);
      expect(() => createHttpKernel(ordinary)).not.toThrow();
    });
  });
});
