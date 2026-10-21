// Type guarantees of the environment reader — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the
// compiler shows them (directives removed once and read), are quoted in the comments.
import { defineConfig, type ConfigOf } from './config.ts';
import { env } from './env.ts';
import type { InferInput, InferOutput } from './standard-schema.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(proof: Equal<A, B>) => proof;

// ——— The sketch: strings in, typed values out ———

export const RedisConfig = defineConfig('redis', {
  env: env({
    REDIS_URL: env.url({ protocols: ['redis', 'rediss'] }).default('redis://127.0.0.1:6379'),
    REDIS_PREFIX: env.string().optional(),
    REDIS_TIMEOUT: env.integer().min(0).default(5000),
    REDIS_TLS: env.boolean().default(false),
    REDIS_ROLE: env.in(['primary', 'replica']).default('primary'),
    REDIS_SENTINELS: env.list(env.url({ protocols: ['redis'] })).default([]),
    REDIS_PORT: env.port(),
  }),
  resolve: (e) => {
    same<typeof e, { REDIS_URL: string; REDIS_PREFIX: string | undefined; REDIS_TIMEOUT: number; REDIS_TLS: boolean; REDIS_ROLE: 'primary' | 'replica'; REDIS_SENTINELS: string[]; REDIS_PORT: number }>(true);
    return { url: e.REDIS_URL, prefix: e.REDIS_PREFIX ?? '', timeout: e.REDIS_TIMEOUT, tls: e.REDIS_TLS };
  },
});
export type RedisConfig = ConfigOf<typeof RedisConfig>;
same<RedisConfig, { url: string; prefix: string; timeout: number; tls: boolean }>(true);

// The input: every variable a string, every one may be missing.
const schema = env({ A: env.integer(), B: env.string().optional() });
same<InferInput<typeof schema>, { readonly A?: string | undefined; readonly B?: string | undefined }>(true);
same<InferOutput<typeof schema>, { A: number; B: string | undefined }>(true);

// A rule between variables names one of them.
env({ APP_LOCALE: env.string(), APP_LOCALES: env.list(env.string()) }).check((e) => e.APP_LOCALES.includes(e.APP_LOCALE), 'APP_LOCALE must be one of APP_LOCALES', 'APP_LOCALE');

// ——— Misuse ———

defineConfig('x', {
  env: env({ FLAG: env.boolean() }),
  // Property 'MISSING' does not exist on type '{ FLAG: boolean; }'.
  // @ts-expect-error — reading a variable the schema does not declare.
  resolve: (e) => e.MISSING,
});

// Argument of type 'string' is not assignable to parameter of type 'number'.
// @ts-expect-error — the default of a number is a number, not its spelling.
env.integer().default('5000');

// Argument of type '"mysql"' is not assignable to parameter of type '"pgsql" | "sqlite"'.
// @ts-expect-error — the default of env.in() is one of its values.
env.in(['sqlite', 'pgsql']).default('mysql');

// Property 'min' does not exist on type 'EnvBlock<boolean>'.
// @ts-expect-error — a boolean has no range.
env.boolean().min(1);

// Property 'regex' does not exist on type 'EnvNumber'.
// @ts-expect-error — a number has no form.
env.integer().regex(/\d+/);

// Property 'min' does not exist on type 'EnvVariable<number>'.
// @ts-expect-error — .default() and .optional() come last: they decide what a missing variable is.
env.integer().default(1).min(0);

// Type 'EnvVariable<number | undefined>' is missing the following properties from type 'EnvBlock<number | undefined>': #spec, check, required, optional, and 3 more.
// @ts-expect-error — an entry of a list is never missing: its block has no .optional() or .default().
env.list(env.integer().optional());

// Type 'number' is not assignable to type 'EnvVariable<unknown>'.
// @ts-expect-error — a variable needs a building block, not a value.
env({ PORT: 3000 });

// Argument of type '(value: boolean) => boolean' is not assignable to parameter of type '(value: string) => boolean'.
//   Types of parameters 'value' and 'value' are incompatible.
//     Type 'string' is not assignable to type 'boolean'.
// @ts-expect-error — a check gets the block's value.
env.string().check((value: boolean) => value, 'never');

// Argument of type '"APP_LOCALES_TYPO"' is not assignable to parameter of type '"APP_LOCALE"'.
// @ts-expect-error — a rule between variables names a declared one.
env({ APP_LOCALE: env.string() }).check(() => true, 'never', 'APP_LOCALES_TYPO');

defineConfig('p', {
  env: env({ PORT: env.port().default(3000) }),
  resolve: (e) => {
    // Type 'number' is not assignable to type 'string'.
    // @ts-expect-error — a port is a number.
    const text: string = e.PORT;
    return text;
  },
});

// Argument of type '"MISSING"' is not assignable to parameter of type '"X"'.
// @ts-expect-error — a retired name points at a declared variable.
env({ X: env.string() }).renamed('OLD_X', 'MISSING');
