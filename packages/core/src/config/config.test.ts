import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../application.ts';
import { Container } from '../container.ts';
import { ConfigError, defineConfig, loadEnv, resolveConfig, type ConfigOf } from './config.ts';
import type { StandardSchemaV1 } from './standard-schema.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

export const AppConfig = defineConfig('app', {
  env: v.object({
    APP_NAME: v.pipe(v.string(), v.nonEmpty()),
    APP_URL: v.pipe(v.string(), v.url()),
    PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL, port: env.PORT }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;

const MailConfig = defineConfig('mail', {
  env: v.object({ MAIL_FROM: v.pipe(v.string(), v.email()) }),
  resolve: (env) => ({ from: env.MAIL_FROM }),
});

// Top-level on purpose: the injection transform derives `inject = [AppConfig]` from the constructor.
export class ShowTitleController {
  readonly #config: AppConfig;
  constructor(config: AppConfig) {
    this.#config = config;
  }
  handle() {
    return `${this.#config.name} on port ${this.#config.port}`;
  }
}

const valid = { APP_NAME: 'BespokeCore', APP_URL: 'http://localhost:3000' };

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('configuration', () => {
  it('validates, transforms and resolves typed configuration', async () => {
    const resolved = await resolveConfig([AppConfig], { ...valid, PORT: '8080' });
    expect(resolved.get(AppConfig)).toEqual({ name: 'BespokeCore', url: 'http://localhost:3000', port: 8080 });
  });

  it('applies schema defaults', async () => {
    expect((await resolveConfig([AppConfig], valid)).get(AppConfig)).toMatchObject({ port: 3000 });
  });

  it('reports every problem across all definitions at once', async () => {
    const error = await rejection(resolveConfig([AppConfig, MailConfig], { APP_URL: 'not a url', PORT: 'eighty', MAIL_FROM: 'nope' }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.split('\n').filter((line) => line.startsWith('  • '))).toEqual([
      '  • app: APP_NAME — Invalid key: Expected "APP_NAME" but received undefined',
      expect.stringMatching(/^ {2}• app: APP_URL — Invalid URL/),
      expect.stringMatching(/^ {2}• app: PORT — Invalid integer/),
      expect.stringMatching(/^ {2}• mail: MAIL_FROM — Invalid email/),
    ]);
  });

  it('accepts any Standard Schema, including async ones', async () => {
    const asyncSchema: StandardSchemaV1<unknown, { TOKEN: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => ({ value: { TOKEN: String((value as Record<string, string>).TOKEN) } }),
      },
    };
    const Secrets = defineConfig('secrets', { env: asyncSchema, resolve: (env) => env.TOKEN });
    expect((await resolveConfig([Secrets], { TOKEN: 'abc' })).get(Secrets)).toBe('abc');
  });
});

describe('loadEnv', () => {
  it('layers .env, .env.{mode} and the real environment, without touching process.env', () => {
    const root = realpathSync(tempDir('bespoke-env-'));
    writeFileSync(join(root, '.env'), 'A=from-env\nB=from-env\n# comment\nQUOTED="x y"\n');
    writeFileSync(join(root, '.env.test'), 'B=from-env-test\nC=from-env-test\n');

    const env = loadEnv(root, 'test', { C: 'from-real-environment' });
    expect(env).toEqual({ A: 'from-env', B: 'from-env-test', C: 'from-real-environment', QUOTED: 'x y' });
    expect(process.env.QUOTED).toBeUndefined();
  });
});

describe('createApplication — configuration', () => {
  it('binds configuration as tokens, so it is constructor-injected', async () => {
    const app = await createApplication({ root: tmpdir(), discover: false, config: [AppConfig], env: valid });
    expect(app.container.make(ShowTitleController).handle()).toBe('BespokeCore on port 3000');
  });

  it('fails before anything boots, with the full list of problems and no stack noise', async () => {
    let booted = false;
    class Provider {
      boot() {
        booted = true;
      }
    }
    const error = await rejection(
      createApplication({ root: tmpdir(), discover: false, config: [AppConfig], providers: [Provider], env: {} }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.stack).toBe(`ConfigError: ${error.message}`);
    expect(booted).toBe(false);
  });
});

// Never called: only the types matter.
export function typeLevelTests(): void {
  const container = new Container();
  const port: number = container.make(AppConfig).port;
  // @ts-expect-error — PORT is transformed to a number by the schema.
  const text: string = container.make(AppConfig).port;
  defineConfig('x', {
    env: v.object({ FLAG: v.string() }),
    // @ts-expect-error — the schema has no MISSING key.
    resolve: (env) => env.MISSING,
  });
  void port;
  void text;
}
