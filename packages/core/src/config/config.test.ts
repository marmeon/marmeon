import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../application.ts';
import { Container } from '../container.ts';
import { ConfigError, defineConfig, loadEnv, resolveConfig, type ConfigOf } from './config.ts';
import { env } from './env.ts';
import type { StandardSchemaV1 } from './standard-schema.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

export const AppConfig = defineConfig('app', {
  env: env({
    APP_NAME: env.string(),
    APP_URL: env.url(),
    PORT: env.integer().default(3000),
  }),
  resolve: (e) => ({ name: e.APP_NAME, url: e.APP_URL, port: e.PORT }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;

const MailConfig = defineConfig('mail', {
  env: env({ MAIL_FROM: env.email() }),
  resolve: (e) => ({ from: e.MAIL_FROM }),
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

const valid = { APP_NAME: 'Marmeon', APP_URL: 'http://localhost:3000' };

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
    expect(resolved.get(AppConfig)).toEqual({ name: 'Marmeon', url: 'http://localhost:3000', port: 8080 });
  });

  it('applies schema defaults', async () => {
    expect((await resolveConfig([AppConfig], valid)).get(AppConfig)).toMatchObject({ port: 3000 });
  });

  it('reports every problem across all definitions at once', async () => {
    const error = await rejection(resolveConfig([AppConfig, MailConfig], { APP_URL: 'not a url', PORT: 'eighty', MAIL_FROM: 'nope' }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.split('\n').filter((line) => line.startsWith('  • '))).toEqual([
      '  • app: APP_NAME — APP_NAME is required.',
      '  • app: APP_URL — APP_URL must be a URL starting with http:// or https://.',
      '  • app: PORT — PORT must be a whole number.',
      '  • mail: MAIL_FROM — MAIL_FROM must be an e-mail address.',
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
    const root = realpathSync(tempDir('marmeon-env-'));
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
    expect(app.container.make(ShowTitleController).handle()).toBe('Marmeon on port 3000');
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
  // @ts-expect-error — PORT is read as a number.
  const text: string = container.make(AppConfig).port;
  defineConfig('x', {
    env: env({ FLAG: env.string() }),
    // @ts-expect-error — the schema has no MISSING key.
    resolve: (e) => e.MISSING,
  });
  void port;
  void text;
}
