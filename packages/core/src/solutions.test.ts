import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig, defineConfig } from './config/config.ts';
import { env } from './config/env.ts';
import { Container, ContainerError } from './container.ts';
import { coreSolutions } from './core-solutions.ts';
import { InjectionError } from './injection/analyze.ts';
import { defineSolutions, ErrorSolutions } from './solutions.ts';
import { token } from './token.ts';

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

describe('the core solutions', () => {
  it('a binding that is missing: bind it in a provider', async () => {
    const [solution] = await solutions.find(thrown(() => new Container().make(WelcomeService)));
    expect(solution).toMatchObject({ title: 'Bind Mailer in a service provider', command: 'marmeon discover', docs: 'docs/container.md#the-containers-errors' });
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
      expect(solution).toMatchObject({ title: 'Install the package as it is published', docs: 'docs/package-development.md#building-and-publishing' });
      expect(solution?.text).toContain('node_modules/shipped/index.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalid configuration: the variables to set', async () => {
    const Config = defineConfig('mail', { env: env({ MAIL_HOST: env.string(), MAIL_PORT: env.port() }), resolve: (e) => e });
    const error = await resolveConfig([Config], {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ConfigError);
    const [solution] = await solutions.find(error);
    expect(solution).toMatchObject({ title: 'Set MAIL_HOST, MAIL_PORT in .env', docs: 'docs/configuration.md#when-a-value-is-wrong' });
  });

  describe('a variable that was renamed', () => {
    const schema = env({ MAIL_HOST: env.string(), MAIL_PORT: env.port().default(25) }).renamed('MAIL_SERVER', 'MAIL_HOST');
    const find = async (environment: Record<string, string>) => {
      const error = await resolveConfig([defineConfig('mail', { env: schema, resolve: (e) => e })], environment).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ConfigError);
      return solutions.find(error);
    };

    it('is not told to be set: the error names the new variable and the docs, so there is no solution of its own', async () => {
      expect(await find({ MAIL_SERVER: 'smtp.example.com', MAIL_HOST: 'smtp.example.com' })).toEqual([]);
    });

    it('stays out of the variables to set next to a missing one, and the text says to rename', async () => {
      const [solution] = await find({ MAIL_SERVER: 'smtp.example.com', MAIL_PORT: 'x' });
      expect(solution).toMatchObject({ title: 'Set MAIL_HOST, MAIL_PORT in .env' });
      expect(solution!.text).not.toContain('MAIL_SERVER');
      expect(solution!.text).toContain('Do not set the renamed variables above under their old name');
    });

    it('does not claim the value is kept when the rename converts it', async () => {
      const converting = env({ MAIL_HOST: env.string(), MAIL_LIMIT_MB: env.integer().default(1) }).renamed('MAIL_LIMIT', 'MAIL_LIMIT_MB', { conversion: 'the old value was in bytes; divide by 1,048,576' });
      const error = await resolveConfig([defineConfig('mail', { env: converting, resolve: (e) => e })], { MAIL_LIMIT: '1048576' }).catch((failure: unknown) => failure);
      const [solution] = await solutions.find(error);
      expect(solution!.title).toBe('Set MAIL_HOST in .env');
      expect(solution!.text).not.toMatch(/keep their value|same value/);
    });

    it('counts a line that only mentions a rename after its own message as a plain issue', async () => {
      const lying = { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'must be set — MAIL_HOST was renamed MAIL_X — no', path: ['MAIL_HOST'] }] }) } } as const;
      const error = await resolveConfig([defineConfig('mail', { env: lying as never, resolve: (e) => e })], {}).catch((failure: unknown) => failure);
      const [solution] = await solutions.find(error);
      expect(solution).toMatchObject({ title: 'Set MAIL_HOST in .env' });
    });
  });

  it('invalid configuration: a nested variable keeps its whole path — and an issue without a path names no word of its message', async () => {
    // A Standard Schema of another library may nest its issues (`SMTP.HOST`) or give one for the whole object.
    const nested = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'Expected a host', path: [{ key: 'SMTP' }, { key: 'HOST' }] }, { message: 'A value is missing' }] }),
      },
    } as const;
    const Config = defineConfig('mail', { env: nested as never, resolve: (e) => e });
    const error = await resolveConfig([Config], {}).catch((failure: unknown) => failure);
    const [solution] = await solutions.find(error);
    expect(solution).toMatchObject({ title: 'Set SMTP.HOST in .env' });
    expect(solution!.text).toContain('SMTP.HOST is missing or invalid');
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

describe('solutions tied to an error code', () => {
  class SetupError extends Error {}

  it('matches only an error with exactly that code, and the solution carries it', async () => {
    const registry = new ErrorSolutions(
      defineSolutions([{ for: SetupError, code: 'K6', solve: () => ({ title: 'Fix K6', text: 'Do it.' }) }]),
    );
    expect(await registry.find(new SetupError('[marmeon:K6] broken'))).toEqual([{ title: 'Fix K6', text: 'Do it.', code: 'K6' }]);
    expect(await registry.find(new SetupError('[marmeon:K7] broken'))).toEqual([]);
    expect(await registry.find(new SetupError('broken'))).toEqual([]);
    expect(await registry.find(new Error('wrapper', { cause: new SetupError('[marmeon:K6] broken') }))).toHaveLength(1);
    // The code must sit on the same level as the class: a wrapper with the code does not make its cause match.
    expect(await registry.find(new Error('[marmeon:K6] wrapper', { cause: new SetupError('broken') }))).toEqual([]);
  });

  it('a definition without a code matches as before, and the solution takes the error\'s code', async () => {
    const registry = new ErrorSolutions(defineSolutions([{ for: SetupError, solve: () => ({ title: 'Fix it', text: 'Do it.' }) }]));
    expect(await registry.find(new SetupError('broken'))).toEqual([{ title: 'Fix it', text: 'Do it.' }]);
    expect(await registry.find(new SetupError('[marmeon:D3] broken'))).toEqual([{ title: 'Fix it', text: 'Do it.', code: 'D3' }]);
  });

  it('the core solutions carry the codes of the errors they solve', async () => {
    const [unbound] = await solutions.find(thrown(() => new Container().make(WelcomeService)));
    expect(unbound?.code).toBe('K1');
    const [numbers] = await solutions.find(thrown(() => new Container().make(Money)));
    expect(numbers?.code).toBe('K3');
  });
});
