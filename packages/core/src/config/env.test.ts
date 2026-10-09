import { describe, expect, it } from 'vitest';
import { ConfigError, defineConfig, resolveConfig } from './config.ts';
import { env, type EnvVariable } from './env.ts';
import type { StandardSchemaV1 } from './standard-schema.ts';

/** What the schema gives back: the values, or `variable — message` per problem (as the start lists them). */
function read<Out>(schema: StandardSchemaV1<unknown, Out>, environment: Record<string, string | undefined>): { value: Out } | { problems: string[] } {
  const result = schema['~standard'].validate(environment);
  if (result instanceof Promise) throw new Error('the env schema must be synchronous');
  return result.issues
    ? { problems: result.issues.map((issue) => `${(issue.path ?? []).join('.')} — ${issue.message}`) }
    : { value: result.value };
}

/** One variable `X`, read from `raw`. */
const one = (variable: EnvVariable<unknown>, raw: string | undefined) => read(env({ X: variable }), { X: raw });

describe('env — the building blocks', () => {
  it('string: any text; min/max its length, regex its form', () => {
    expect(one(env.string(), ' Ada ')).toEqual({ value: { X: ' Ada ' } });
    expect(one(env.string().min(3), 'ab')).toEqual({ problems: ['X — X must be at least 3 characters long.'] });
    expect(one(env.string().max(3), 'abcd')).toEqual({ problems: ['X — X must be at most 3 characters long.'] });
    expect(one(env.string().min(2).max(3), 'abc')).toEqual({ value: { X: 'abc' } });
    expect(one(env.string().regex(/^[\w-]+$/), 'a b')).toEqual({ problems: ['X — X must match /^[\\w-]+$/.'] });
    expect(one(env.string().regex(/^[a-z]+$/, 'lower-case letters only'), 'ABC')).toEqual({ problems: ['X — lower-case letters only'] });
    // A global regex keeps its lastIndex between tests; the block drops the flag, so the same value matches every time.
    const twice = env.string().regex(/a/g);
    expect([one(twice, 'a'), one(twice, 'a')]).toEqual([{ value: { X: 'a' } }, { value: { X: 'a' } }]);
  });

  it('integer: a whole number, as written in decimal; min/max its range', () => {
    expect(one(env.integer(), '5000')).toEqual({ value: { X: 5000 } });
    expect(one(env.integer(), '-3')).toEqual({ value: { X: -3 } });
    expect(one(env.integer(), '+7')).toEqual({ value: { X: 7 } });
    // Only a sign and decimal digits — as the whole-number variables take them today (KEEP_ALIVE_TIMEOUT, AUTH_UNVERIFIED_DAYS).
    for (const raw of ['1.5', 'ten', '0x10', '12abc', 'Infinity', '9007199254740993', '1e3', '5.', '.5', ' 5', '5 ', '--5']) {
      expect(one(env.integer(), raw), raw).toEqual({ problems: ['X — X must be a whole number.'] });
    }
    expect(one(env.integer().min(1), '0')).toEqual({ problems: ['X — X must be at least 1.'] });
    expect(one(env.integer().max(300), '301')).toEqual({ problems: ['X — X must be at most 300.'] });
    expect(one(env.integer('X must be a number of seconds'), 'soon')).toEqual({ problems: ['X — X must be a number of seconds'] });
    expect(one(env.integer().min(1, 'Expected at least 1 second'), '0')).toEqual({ problems: ['X — Expected at least 1 second'] });
  });

  it('number: decimals too', () => {
    expect(one(env.number(), '0.5')).toEqual({ value: { X: 0.5 } });
    expect(one(env.number().max(300), '300.5')).toEqual({ problems: ['X — X must be at most 300.'] });
    for (const raw of ['5s', '1e3', '5.', '.5', 'Infinity', 'NaN', ' 1']) expect(one(env.number(), raw), raw).toEqual({ problems: ['X — X must be a number.'] });
    expect(one(env.number('Expected seconds, like 5 or 0.5'), '5s')).toEqual({ problems: ['X — Expected seconds, like 5 or 0.5'] });
  });

  it('boolean: true/false and 1/0, in any case — anything else is a problem, not false', () => {
    for (const [raw, value] of [['true', true], ['TRUE', true], ['1', true], ['false', false], ['False', false], ['0', false]] as const) {
      expect(one(env.boolean(), raw), raw).toEqual({ value: { X: value } });
    }
    // `constructor`, `__proto__`, `toString`: names Object.prototype has — never a value.
    for (const raw of ['yes', 'off', 'tru', '2', 'constructor', 'CONSTRUCTOR', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(one(env.boolean(), raw), raw).toEqual({ problems: ['X — X must be true or false (or 1 or 0).'] });
    }
  });

  it('in: one of the values, case-sensitive', () => {
    expect(one(env.in(['sqlite', 'pgsql']), 'pgsql')).toEqual({ value: { X: 'pgsql' } });
    expect(one(env.in(['sqlite', 'pgsql']), 'PGSQL')).toEqual({ problems: ['X — X must be sqlite or pgsql.'] });
    expect(one(env.in(['file', 'memory', 'database', 'redis']), 'disk')).toEqual({ problems: ['X — X must be file, memory, database or redis.'] });
    expect(one(env.in(['memory', 'redis'], 'Expected memory or redis'), 'x')).toEqual({ problems: ['X — Expected memory or redis'] });
    expect(() => env.in(['', 'a'])).toThrow('env.in(): an empty variable is a missing one, so "" is never a value');
  });

  it('url: an absolute URL with //, http(s) unless protocols names others', () => {
    expect(one(env.url(), 'https://app.example.com/x')).toEqual({ value: { X: 'https://app.example.com/x' } });
    for (const raw of ['app.example.com', 'javascript:alert(1)', 'ftp://example.com', 'https://exa mple.com']) {
      expect(one(env.url(), raw), raw).toEqual({ problems: ['X — X must be a URL starting with http:// or https://.'] });
    }
    const redis = env.url({ protocols: ['redis', 'rediss'] });
    expect(one(redis, 'rediss://:secret@cache.internal:6380/2')).toEqual({ value: { X: 'rediss://:secret@cache.internal:6380/2' } });
    // `localhost:6379` parses as a URL with the scheme `localhost:` — an address without `//` is not one.
    for (const raw of ['localhost:6379', 'redis:cache', 'http://cache']) {
      expect(one(redis, raw), raw).toEqual({ problems: ['X — X must be a URL starting with redis:// or rediss://.'] });
    }
    expect(one(env.url({ protocols: ['postgres'], message: 'Expected a postgres:// URL' }), 'mysql://x')).toEqual({ problems: ['X — Expected a postgres:// URL'] });
  });

  it('port: 1 to 65535', () => {
    expect(one(env.port(), '5432')).toEqual({ value: { X: 5432 } });
    for (const raw of ['0', '65536', '80.5', 'http', '8e1', '80.']) expect(one(env.port(), raw), raw).toEqual({ problems: ['X — X must be a port from 1 to 65535.'] });
  });

  it('email: an address', () => {
    expect(one(env.email(), 'hello@example.com')).toEqual({ value: { X: 'hello@example.com' } });
    expect(one(env.email(), 'hello')).toEqual({ problems: ['X — X must be an e-mail address.'] });
    expect(one(env.email('MAIL_FROM_ADDRESS must be an e-mail address'), 'x@')).toEqual({ problems: ['X — MAIL_FROM_ADDRESS must be an e-mail address'] });
  });

  it('list: entries split at the separator, trimmed, empty ones dropped, each read by its block', () => {
    expect(one(env.list(env.email()), ' ada@example.com,, alan@example.com ')).toEqual({ value: { X: ['ada@example.com', 'alan@example.com'] } });
    expect(one(env.list(env.integer().min(1)), '1;2;3')).toEqual({ problems: ['X — X entry 1 must be a whole number.'] });
    expect(one(env.list(env.integer().min(1), { separator: ';' }), '1; 2;3')).toEqual({ value: { X: [1, 2, 3] } });
    expect(one(env.list(env.string()), ',')).toEqual({ value: { X: [] } });
    // One problem per variable — the first wrong entry, by its place: the value may be a secret.
    expect(one(env.list(env.email()), 'ada@example.com, nope, also-nope')).toEqual({ problems: ['X — X entry 2 must be an e-mail address.'] });
    // A check of the whole list names every wrong entry, when its message is made from the value.
    const proxies = env.list(env.string()).check(
      (entries) => entries.every((entry) => entry === '*' || /^[\d./]+$/.test(entry)),
      (entries) => `Expected addresses or ranges like 10.0.0.0/8, or *: ${entries.filter((entry) => entry !== '*' && !/^[\d./]+$/.test(entry)).join(', ')} is not one`,
    );
    expect(one(proxies, '10.0.0.0/8, proxy.internal')).toEqual({ problems: ['X — Expected addresses or ranges like 10.0.0.0/8, or *: proxy.internal is not one'] });
    expect(() => env.list(env.string(), { separator: '' })).toThrow('env.list(): the separator cannot be empty.');
  });

  it('check: a rule of your own after the block read the value', () => {
    const lifetime = env.integer().min(1).check((minutes) => minutes <= 1440, 'At most a day (1440).');
    expect(one(lifetime, '1441')).toEqual({ problems: ['X — At most a day (1440).'] });
    expect(one(lifetime, '0')).toEqual({ problems: ['X — X must be at least 1.'] }); // the first problem only
    expect(one(lifetime, '60')).toEqual({ value: { X: 60 } });
  });

  it('every block is immutable: a method returns a new one', () => {
    const base = env.integer();
    const bounded = base.max(10);
    expect(one(base, '11')).toEqual({ value: { X: 11 } });
    expect(one(bounded, '11')).toEqual({ problems: ['X — X must be at most 10.'] });
  });
});

describe('env — missing variables', () => {
  const blocks = {
    string: env.string(),
    integer: env.integer(),
    number: env.number(),
    boolean: env.boolean(),
    in: env.in(['a', 'b']),
    url: env.url(),
    port: env.port(),
    email: env.email(),
    list: env.list(env.string()),
  };

  it('missing or empty: required by default, for every block', () => {
    for (const [kind, block] of Object.entries(blocks)) {
      expect(one(block, undefined), kind).toEqual({ problems: ['X — X is required.'] });
      expect(one(block, ''), `${kind}, empty`).toEqual({ problems: ['X — X is required.'] });
    }
  });

  it('missing or empty: undefined with .optional()', () => {
    for (const [kind, block] of Object.entries(blocks)) {
      expect(one(block.optional(), undefined), kind).toEqual({ value: { X: undefined } });
      expect(one(block.optional(), ''), `${kind}, empty`).toEqual({ value: { X: undefined } });
    }
    // A value present is read as without .optional().
    expect(one(env.integer().optional(), 'x')).toEqual({ problems: ['X — X must be a whole number.'] });
  });

  it('missing or empty: the default with .default() — a value present is read and checked', () => {
    expect(one(env.integer().min(0).default(5000), '')).toEqual({ value: { X: 5000 } });
    expect(one(env.integer().min(0).default(5000), undefined)).toEqual({ value: { X: 5000 } });
    expect(one(env.integer().min(0).default(5000), '-1')).toEqual({ problems: ['X — X must be at least 0.'] });
    expect(one(env.string().default(''), '')).toEqual({ value: { X: '' } }); // an empty default is the program's, not the .env's
    expect(one(env.boolean().default(false), '')).toEqual({ value: { X: false } });
    expect(one(env.in(['sqlite', 'pgsql']).default('sqlite'), '')).toEqual({ value: { X: 'sqlite' } });
  });

  it('a list default is a fresh copy each time — a resolve that changes it changes nothing else', () => {
    const schema = env({ ADMINS: env.list(env.email()).default(['ada@example.com']) });
    const first = read(schema, {}) as { value: { ADMINS: string[] } };
    first.value.ADMINS.push('mallory@example.com');
    expect(read(schema, {})).toEqual({ value: { ADMINS: ['ada@example.com'] } });
  });

  it('.required(message): the message for a missing variable, such as the command that sets it', () => {
    const key = env.string().required('Missing — run "marmeon key:generate"').check((value) => value.startsWith('base64:'), 'Expected "base64:" followed by 32 bytes');
    expect(one(key, '')).toEqual({ problems: ['X — Missing — run "marmeon key:generate"'] });
    expect(one(key, 'plain')).toEqual({ problems: ['X — Expected "base64:" followed by 32 bytes'] });
    expect(one(env.string().required(), undefined)).toEqual({ problems: ['X — X is required.'] });
  });
});

describe('env({ … }) — the schema', () => {
  const schema = env({
    REDIS_URL: env.url({ protocols: ['redis', 'rediss'] }).default('redis://127.0.0.1:6379'),
    REDIS_PREFIX: env.string().optional(),
    REDIS_TIMEOUT: env.integer().min(0).default(5000),
    REDIS_TLS: env.boolean().default(false),
  });

  it('is a synchronous Standard Schema of the framework', () => {
    expect(schema['~standard']).toMatchObject({ version: 1, vendor: 'marmeon' });
    expect(schema['~standard'].validate({})).not.toBeInstanceOf(Promise);
  });

  it('reads the declared variables and leaves every other out', () => {
    expect(read(schema, { REDIS_PREFIX: '', REDIS_TIMEOUT: '250', HOME: '/root', PATH: '/bin' })).toEqual({
      value: { REDIS_URL: 'redis://127.0.0.1:6379', REDIS_PREFIX: undefined, REDIS_TIMEOUT: 250, REDIS_TLS: false },
    });
  });

  it('reads every variable and gives one problem per wrong one, in the order declared — never the value', () => {
    const result = read(schema, { REDIS_URL: 'localhost:6379', REDIS_TIMEOUT: '-5', REDIS_TLS: 'yes-secret-value' });
    expect(result).toEqual({
      problems: [
        'REDIS_URL — REDIS_URL must be a URL starting with redis:// or rediss://.',
        'REDIS_TIMEOUT — REDIS_TIMEOUT must be at least 0.',
        'REDIS_TLS — REDIS_TLS must be true or false (or 1 or 0).',
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('a value that is not a string (an env object built in code) is a problem, not a crash', () => {
    expect(read(schema, { REDIS_TIMEOUT: 250 as never })).toEqual({ problems: ['REDIS_TIMEOUT — REDIS_TIMEOUT must be a string, as every environment variable is.'] });
    expect(schema['~standard'].validate(null)).toEqual({ issues: [{ message: 'The environment must be an object of strings.' }] });
  });

  it('a variable named __proto__ is a key like any other, never the prototype of the values', () => {
    const result = read(env({ ['__proto__']: env.string() }), JSON.parse('{"__proto__": "x"}') as Record<string, string>) as { value: object };
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result.value, '__proto__')?.value).toBe('x');
  });

  it('.check(): a rule between variables, under the variable it names — only once every variable read cleanly', () => {
    const locales = env({ APP_LOCALE: env.string().default('en'), APP_LOCALES: env.list(env.string()).default([]) }).check(
      (e) => e.APP_LOCALES.length === 0 || e.APP_LOCALES.includes(e.APP_LOCALE),
      'APP_LOCALE must be one of APP_LOCALES',
      'APP_LOCALE',
    );
    expect(read(locales, { APP_LOCALE: 'de', APP_LOCALES: 'en,de' })).toEqual({ value: { APP_LOCALE: 'de', APP_LOCALES: ['en', 'de'] } });
    expect(read(locales, { APP_LOCALE: 'fr', APP_LOCALES: 'en,de' })).toEqual({ problems: ['APP_LOCALE — APP_LOCALE must be one of APP_LOCALES'] });
    const strict = locales.check(() => false, (e) => `never (${e.APP_LOCALE})`, 'APP_LOCALES');
    expect(read(strict, { APP_LOCALE: 'fr', APP_LOCALES: 'en' })).toEqual({
      problems: ['APP_LOCALE — APP_LOCALE must be one of APP_LOCALES', 'APP_LOCALES — never (fr)'],
    });
    // `locales` itself is unchanged by .check(): a new schema.
    expect(read(locales, { APP_LOCALE: 'en', APP_LOCALES: 'en' })).toEqual({ value: { APP_LOCALE: 'en', APP_LOCALES: ['en'] } });
  });
});

describe('env through defineConfig — the start error', () => {
  const AppConfig = defineConfig('app', {
    env: env({ APP_NAME: env.string(), APP_URL: env.url(), PORT: env.port().default(3000), ADMINS: env.list(env.email()).default([]) }),
    resolve: (e) => ({ name: e.APP_NAME, url: e.APP_URL, port: e.PORT, admins: e.ADMINS }),
  });
  const EncryptionConfig = defineConfig('encryption', {
    env: env({ APP_KEY: env.string().required('Missing — run "marmeon key:generate"') }),
    resolve: (e) => ({ key: e.APP_KEY }),
  });

  it('resolves typed values', async () => {
    const resolved = await resolveConfig([AppConfig], { APP_NAME: 'Marmeon', APP_URL: 'http://localhost:3000', PORT: '', ADMINS: 'ada@example.com' });
    expect(resolved.get(AppConfig)).toEqual({ name: 'Marmeon', url: 'http://localhost:3000', port: 3000, admins: ['ada@example.com'] });
  });

  it('lists every problem of every definition at once, in the format of every start', async () => {
    const error = (await resolveConfig([AppConfig, EncryptionConfig], { APP_NAME: '', APP_URL: 'localhost', PORT: '70000', ADMINS: 'ada@example.com, nope', APP_KEY: '' }).catch(
      (failure: unknown) => failure,
    )) as Error;
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(
      [
        'Invalid configuration — the application cannot start:',
        '  • app: APP_NAME — APP_NAME is required.',
        '  • app: APP_URL — APP_URL must be a URL starting with http:// or https://.',
        '  • app: PORT — PORT must be a port from 1 to 65535.',
        '  • app: ADMINS — ADMINS entry 2 must be an e-mail address.',
        '  • encryption: APP_KEY — Missing — run "marmeon key:generate"',
        'Set these variables in the environment or in .env (see .env.example).',
      ].join('\n'),
    );
  });
});
