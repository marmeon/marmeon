import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig, defineConfig } from './config/config.ts';
import { Container, ContainerError } from './container.ts';
import { coreSolutions } from './core-solutions.ts';
import { InjectionError } from './injection/analyze.ts';
import { defineSolutions, ErrorSolutions } from './solutions.ts';
import { token } from './token.ts';
import * as v from 'valibot';

interface Mailer {
  send(): void;
}
const Mailer = token<Mailer>('Mailer');
class WelcomeService {
  static inject = [Mailer] as const;
  constructor(_mailer: Mailer) {}
}
class Money {
  constructor(_amount: number) {}
}

const solutions = new ErrorSolutions(coreSolutions);
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
};

describe('the core solutions (E130)', () => {
  it('a binding that is missing: bind it in a provider', async () => {
    const [solution] = await solutions.find(thrown(() => new Container().make(WelcomeService)));
    expect(solution).toMatchObject({ title: 'Bind Mailer in a service provider', command: 'marmeon discover', docs: 'packages/core/README.md#the-containers-errors' });
    expect(solution?.text).toContain('(needed by WelcomeService)');
  });

  it('a scoped service outside a scope, and in a singleton', async () => {
    class Scoped {}
    class Shared {
      static inject = [Scoped] as const;
      constructor(_scoped: Scoped) {}
    }
    const outside = await solutions.find(thrown(() => new Container().scoped(Scoped).make(Scoped)));
    expect(outside[0]?.title).toBe('Resolve Scoped inside a scope');
    const captured = await solutions.find(thrown(() => new Container().scoped(Scoped).singleton(Shared).make(Shared)));
    expect(captured[0]?.title).toBe('Do not resolve the scoped Scoped from a singleton');
  });

  it('a class without an injection list — with the transform’s reason', async () => {
    const [solution] = await solutions.find(thrown(() => new Container().make(Money)));
    expect(solution?.title).toBe('Inject a class or a token');
    expect(solution?.text).toMatch(/only classes and tokens can be injected, not "number".*inject the config object/);
  });

  it('a circular dependency', async () => {
    class A {
      static inject: unknown[] = [];
      constructor(_b: unknown) {}
    }
    class B {
      static inject = [A] as const;
      constructor(_a: A) {}
    }
    A.inject = [B];
    const [solution] = await solutions.find(thrown(() => new Container().make(A)));
    expect(solution).toMatchObject({ title: 'Break the circular dependency' });
    expect(solution?.text).toMatch(/^A → B → A:/);
  });

  it('an InjectionError (package:build)', async () => {
    const [solution] = await solutions.find(new InjectionError('Cannot inject x.ts:1 — A, parameter "m": "Mailer" is imported with "import type", so it does not exist at runtime.'));
    expect(solution?.title).toBe('Import the token as a value');
  });

  it('TypeScript under node_modules: install the package as it is published (its dist/)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-ts-in-node-modules-')));
    try {
      mkdirSync(join(dir, 'node_modules/shipped'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/shipped/index.ts'), 'export const value: number = 1;\n');
      // Node's own import, in a process of its own (Vitest's would transform the file): the error Node throws, as it threw it.
      const script = `import(${JSON.stringify(pathToFileURL(join(dir, 'node_modules/shipped/index.ts')).href)}).catch((e) => console.log(JSON.stringify({ code: e.code, message: e.message })))`;
      const thrownByNode = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).stdout) as { code: string; message: string };
      const error = Object.assign(new Error(thrownByNode.message), { code: thrownByNode.code });
      expect((error as { code?: string }).code).toBe('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      const [solution] = await solutions.find(error);
      expect(solution).toMatchObject({ title: 'Install the package as it is published', docs: 'packages/core/README.md#discovery-the-marmeon-field-and-marmeon-discover' });
      expect(solution?.text).toContain('node_modules/shipped/index.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalid configuration: the variables to set', async () => {
    const Config = defineConfig('mail', { env: v.object({ MAIL_HOST: v.string(), MAIL_PORT: v.string() }), resolve: (env) => env });
    const error = await resolveConfig([Config], {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ConfigError);
    const [solution] = await solutions.find(error);
    expect(solution).toMatchObject({ title: 'Set MAIL_HOST, MAIL_PORT in .env', docs: 'packages/core/README.md#configuration' });
  });
});

describe('ErrorSolutions', () => {
  it('looks through causes, keeps each title once, and leaves out a solution that fails', async () => {
    class PaymentError extends Error {}
    const registry = new ErrorSolutions(
      defineSolutions([
        { for: PaymentError, solve: () => ({ title: 'Check the payment provider', text: 'It is down.' }) },
        { for: PaymentError, solve: () => ({ title: 'Check the payment provider', text: 'Twice.' }) },
        {
          for: PaymentError,
          solve: () => {
            throw new Error('lookup failed');
          },
        },
        { for: Error, when: (e) => e.message === 'never', solve: () => ({ title: 'Never', text: '' }) },
      ]),
    );
    const found = await registry.find(new Error('Checkout failed', { cause: new PaymentError('declined') }));
    expect(found).toEqual([{ title: 'Check the payment provider', text: 'It is down.' }]);
  });

  it('types each entry’s error by its class', () => {
    defineSolutions([
      { for: ContainerError, when: (e) => e.reason === 'unbound', solve: (e) => ({ title: e.key ?? '', text: '' }) },
      { for: ConfigError, solve: (e) => ({ title: e.message, text: '' }) },
      // @ts-expect-error — a ConfigError has no `reason`.
      { for: ConfigError, when: (e) => e.reason === 'unbound', solve: () => undefined },
      // @ts-expect-error — a solution needs a text.
      { for: ContainerError, solve: () => ({ title: 'Only a title' }) },
    ]);
  });
});
