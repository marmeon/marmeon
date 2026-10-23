import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { docsTable, envNameProblems, envNames, kindOf, packageSources, switchReadAsText, type EnvName, type EnvNames, type TableRow } from './env-names.ts';
import { tempDir } from './test/temp-dir.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('the environment variables of the repository', () => {
  it('are the table in docs/configuration.md, and follow the naming rules', () => {
    const names = envNames(root);
    expect(names.current.length).toBeGreaterThan(100);
    expect(envNameProblems(names, docsTable(readFileSync(join(root, 'docs/configuration.md'), 'utf8')))).toEqual([]);
  });

  it('are read as booleans, never as text', () => {
    expect(switchReadAsText(packageSources(root))).toEqual([]);
  });

  it('list the switches of experimental packages and of providers an app adds by hand', () => {
    const byName = new Map(envNames(root).current.map((variable) => [variable.name, variable]));
    expect(byName.get('MARMEON_OTEL_TRUST_TRACEPARENT')?.packages).toEqual(['otel']);
    expect(byName.get('LIVE_DRIVER')?.packages).toEqual(['live']);
    expect(byName.get('AUTH_PASSKEY_RP_ID')?.packages).toEqual(['auth']);
    expect(byName.get('DEVTOOLS_ENABLED')).toMatchObject({ packages: ['devtools'], boolean: true });
    expect(kindOf(byName.get('DEVTOOLS_ENABLED')!)).toBe('switch');
  });
});

describe('envNames', () => {
  it('reads variables and retired names from the Environment and Experimental sections, and nothing else', () => {
    const dir = tempDir('marmeon-env-names-');
    const write = (name: string, markdown: string) => {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(join(dir, 'packages', name, 'api.md'), markdown);
    };
    write('one', '## Environment\n\n```ts\n// ONE_PORT\n`ONE_PORT` = `1`\n// ONE_OLD\n`ONE_OLD` → `ONE_PORT` (renamed)\n// ONE_ON\n`ONE_ON` — optional (boolean)\n```\n');
    write('two', '## Experimental\n\n```ts\n// TWO_URL\n`TWO_URL` — required\n// two:run\nmarmeon two:run\n```\n');
    write('three', '## Environment\n\n```ts\n// ONE_PORT\n`ONE_PORT` = `2`\n```\n');
    expect(envNames(dir)).toEqual({
      current: [
        { name: 'ONE_ON', packages: ['one'], default: 'optional', boolean: true },
        { name: 'ONE_PORT', packages: ['one', 'three'], default: '`1` / `2`', boolean: false, disagreeing: true },
        { name: 'TWO_URL', packages: ['two'], default: 'required', boolean: false },
      ],
      retired: [{ name: 'ONE_OLD', to: 'ONE_PORT', package: 'one' }],
    });
  });
});

describe('envNames and two definitions', () => {
  it('marks a variable that one package reads differently in two configs', () => {
    const dir = tempDir('marmeon-env-names-');
    mkdirSync(join(dir, 'packages/one'), { recursive: true });
    writeFileSync(join(dir, 'packages/one/api.md'), '## Environment\n\n```ts\n// ONE_URL\n`ONE_URL` — optional (a); = `"x"` (b)\n```\n');
    expect(envNames(dir).current).toEqual([{ name: 'ONE_URL', packages: ['one'], default: 'optional', boolean: false, divergent: true }]);
  });
});

describe('envNames and one name in two packages', () => {
  it('names a variable that one package gives a default and another leaves optional — one name, one default', () => {
    const dir = tempDir('marmeon-env-names-');
    for (const [name, line] of [['one', '`AUTH_NAME` = `"a"`'], ['two', '`AUTH_NAME` — optional']] as const) {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(join(dir, 'packages', name, 'api.md'), `## Environment\n\n\`\`\`ts\n// AUTH_NAME\n${line}\n\`\`\`\n`);
    }
    const names = envNames(dir);
    expect(names.current).toEqual([{ name: 'AUTH_NAME', packages: ['one', 'two'], default: '`"a"` / optional', boolean: false, disagreeing: true }]);
    const row = { name: 'AUTH_NAME', packages: 'one, two', kind: 'value', default: '`"a"` / optional', page: '[Demo](demo.md#configuration)' };
    expect(envNameProblems(names, [row])).toEqual([expect.stringMatching(/^AUTH_NAME \(one, two\): the configs that read it disagree on its default/)]);
  });

  it('takes the same default in two packages', () => {
    const dir = tempDir('marmeon-env-names-');
    for (const name of ['one', 'two']) {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(join(dir, 'packages', name, 'api.md'), '## Environment\n\n```ts\n// AUTH_NAME\n`AUTH_NAME` — optional\n```\n');
    }
    expect(envNames(dir).current).toEqual([{ name: 'AUTH_NAME', packages: ['one', 'two'], default: 'optional', boolean: false }]);
  });
});

describe('envNameProblems', () => {
  const variable = (name: string, value = '`1`', more: Partial<EnvName> = {}): EnvName => ({ name, packages: ['demo'], default: value, boolean: false, ...more });
  const row = (entry: EnvName, more: Partial<TableRow> = {}): TableRow => ({
    name: entry.name,
    packages: entry.packages.join(', '),
    kind: kindOf(entry),
    default: entry.default,
    page: '[Demo](demo.md#configuration)',
    ...more,
  });
  const check = (current: EnvName[], rows: TableRow[] = current.map((entry) => row(entry)), retired: EnvNames['retired'] = []) => envNameProblems({ current, retired }, rows);

  it('passes a table that matches the snapshots', () => {
    expect(check([variable('AUTH_REMEMBER_DAYS'), variable('PORT', '`3000`'), variable('OTEL_SDK_DISABLED', '`"false"`')])).toEqual([]);
  });

  it('names a variable the table lacks, and a row no snapshot has', () => {
    const current = [variable('AUTH_A'), variable('AUTH_B')];
    expect(check(current, [row(current[0]!), row(variable('AUTH_GONE'))])).toEqual([
      'AUTH_GONE: the table in docs/configuration.md lists it, but no api.md has it — remove the row',
      'AUTH_B (demo): docs/configuration.md › "Every variable" has no row for it — add one',
    ]);
  });

  it('names a variable without the prefix of an area', () => {
    expect(check([variable('BAR_NAME')])).toEqual([expect.stringMatching(/^BAR_NAME \(demo\): it starts with no area prefix/)]);
    expect(check([variable('NODE_ENV', 'optional'), variable('HOST', '`"x"`'), variable('OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST', '`[]`')])).toEqual([]);
  });

  it('names a duration without its unit, and accepts the units and the rates', () => {
    expect(check([variable('AUTH_FOO_TIMEOUT')])).toEqual([expect.stringMatching(/^AUTH_FOO_TIMEOUT \(demo\): it names a duration, so it ends with its unit/)]);
    for (const name of ['SESSION_LIFETIME', 'QUEUE_RETRY_AFTER', 'LIVE_HEARTBEAT', 'UPLOADS_SEND_WITHIN', 'AUTH_RESET_THROTTLE', 'CACHE_MAX_AGE']) {
      expect(check([variable(name)]), name).toHaveLength(1);
    }
    for (const unit of ['MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS', 'DAYS']) expect(check([variable(`AUTH_FOO_TIMEOUT_${unit}`)])).toEqual([]);
    expect(check([variable('AUTH_RETRY_ATTEMPTS_PER_MINUTE')])).toEqual([]);
    expect(check([variable('AUTH_PAGE_SIZE'), variable('AUTH_MESSAGE')])).toEqual([]);
  });

  it('finds a duration by the start of a word, and takes TIME as no duration', () => {
    for (const name of ['AUTH_EXPIRES', 'AUTH_EXPIRY', 'CACHE_WINDOW', 'AUTH_GRACE_PERIOD', 'QUEUE_BACKOFF', 'LIVE_IDLE', 'CACHE_STALE', 'QUEUE_WAIT', 'AUTH_DURATION']) {
      expect(check([variable(name)]), name).toEqual([expect.stringContaining('it names a duration')]);
    }
    expect(check([variable('AUTH_EXPIRES_DAYS'), variable('HASH_ARGON_TIME', '`2`')])).toEqual([]);
    expect(check(['AUTH_EXPIRATION', 'AUTH_EXPIRES'].map((name) => variable(name)))).toHaveLength(2);
    expect(check(['LOG_USER_AGENT', 'SERVER_GRACEFUL', 'QUEUE_WAITING_LIST', 'AUTH_AGENCY', 'CACHE_AFTERMATH'].map((name) => variable(name)))).toEqual([]);
  });

  it('refuses an abbreviated unit and names the long form', () => {
    expect(check([variable('AUTH_REMEMBER_MS')])).toEqual(['AUTH_REMEMBER_MS (demo): it ends with the abbreviated unit _MS — write _MILLISECONDS']);
    for (const [short, long] of [['SEC', 'SECONDS'], ['SECS', 'SECONDS'], ['MIN', 'MINUTES'], ['MINS', 'MINUTES'], ['HRS', 'HOURS']]) {
      expect(check([variable(`AUTH_REMEMBER_${short}`)])).toEqual([expect.stringContaining(`write _${long}`)]);
    }
    expect(check([variable('AUTH_REMEMBER_SECONDS')])).toEqual([]);
  });

  it('names a variable that two configs of a package read differently', () => {
    expect(check([variable('AUTH_A', '`1`', { divergent: true })])).toEqual([expect.stringMatching(/^AUTH_A \(demo\): two configs of the package read it differently/)]);
  });

  it('takes a text switch by any case of its default, and by 1 and 0', () => {
    for (const value of ['`"True"`', '`"FALSE"`', '`"1"`', '`"0"`']) expect(check([variable('AUTH_FLAG', value)]), value).toEqual([expect.stringContaining('read as a string')]);
    expect(check([variable('AUTH_COUNT', '`1`')])).toEqual([]);
  });

  it('names a switch read as text, and a unit on a switch', () => {
    expect(check([variable('AUTH_FLAG', '`"true"`')])).toEqual([expect.stringMatching(/^AUTH_FLAG \(demo\): it is a switch read as a string/)]);
    expect(check([variable('AUTH_FLAG_SECONDS', '`true`')])).toEqual([expect.stringMatching(/ends with a unit but is a switch/)]);
    expect(check([variable('OTEL_SDK_DISABLED', '`"false"`')])).toEqual([]);
  });

  it('keeps _DRIVER and _CONNECTION to their meaning', () => {
    const driver = variable('CACHE_DRIVER', '`"file"`');
    expect(check([driver, variable('CACHE_CONNECTION', '`"file"`')])).toEqual([expect.stringMatching(/^CACHE_CONNECTION \(demo\): _CONNECTION names a database or Redis connection/)]);
    expect(check([driver, variable('CACHE_CONNECTION', '`"default"`')])).toEqual([]);
    expect(check([variable('CACHE_STORE_DRIVER_NAME')])).toEqual([expect.stringMatching(/a variable that picks a driver ends with _DRIVER/)]);
    expect(check([variable('CACHE_CONNECTION_NAME')])).toEqual([expect.stringMatching(/a variable that names a connection ends with _CONNECTION/)]);
  });

  it('compares the package, the kind, the default and the link of a row', () => {
    const entry = variable('AUTH_REMEMBER_DAYS');
    const problem = (more: Partial<TableRow>) => check([entry], [row(entry, more)]);
    expect(problem({ packages: 'other' })).toEqual([expect.stringContaining('names the package(s) other, the snapshots say demo')]);
    expect(problem({ kind: 'value' })).toEqual([expect.stringContaining('gives the kind value, the name and default say duration')]);
    expect(problem({ default: '`2`' })).toEqual([expect.stringContaining('gives the default `2`, the snapshots say `1`')]);
    expect(problem({ page: 'demo' })).toEqual([expect.stringContaining('has no link to a page')]);
    expect(check([entry], [row(entry), row(entry)])).toEqual(['AUTH_REMEMBER_DAYS: the table in docs/configuration.md lists it twice']);
  });

  it('refuses a retired name that is current again (negative)', () => {
    const current = [variable('AUTH_REMEMBER_DAYS'), variable('AUTH_REMEMBER')];
    expect(check(current, undefined, [{ name: 'AUTH_REMEMBER', to: 'AUTH_REMEMBER_DAYS', package: 'demo' }])).toEqual([
      'AUTH_REMEMBER (demo): it is retired for AUTH_REMEMBER_DAYS but a config reads it — a retired name is never given out again',
    ]);
  });

  it('names a retired name whose successor no config reads', () => {
    expect(check([variable('AUTH_A')], undefined, [{ name: 'AUTH_OLD', to: 'AUTH_NEW', package: 'demo' }])).toEqual([
      'AUTH_OLD (demo): it is retired for AUTH_NEW, which no config reads',
    ]);
  });
});

describe('docsTable', () => {
  it('reads the rows of the section and stops at the next heading', () => {
    const markdown = '# C\n\n## Every variable\n\n| Variable | Package | Kind | Default | Page |\n| --- | --- | --- | --- | --- |\n| `A_B` | x, y | value | `1` | [P](p.md#q) |\n\n## Testing\n\n| `NOT_ME` | x | value | `1` | [P](p.md) |\n';
    expect(docsTable(markdown)).toEqual([{ name: 'A_B', packages: 'x, y', kind: 'value', default: '`1`', page: '[P](p.md#q)' }]);
  });
});

describe('switchReadAsText', () => {
  const problems = (path: string, text: string) => switchReadAsText(new Map([[path, text]]));

  it('finds env.in(["true", "false"]) in either order and a true|false pattern in the code of a package, not in a test', () => {
    expect(problems('packages/a/src/config.ts', "env({ X: env.in(['true', 'false']) })")).toHaveLength(1);
    expect(problems('packages/a/src/config.ts', "env({ X: env.in(['false', 'true'], 'Expected a switch') })")).toHaveLength(1);
    expect(problems('packages/b/src/flag.ts', 'const on = /^(?:true|false)$/i;')).toHaveLength(1);
    expect(problems('packages/b/src/flag.ts', 'const on = /^(?:false|true)$/i;')).toHaveLength(1);
    expect(problems('packages/c/src/config.test.ts', "env.in(['true', 'false'])")).toEqual([]);
    expect(problems('packages/d/src/ok.ts', "env.boolean(); env.in(['a', 'b']); env.in(['true', 'maybe'])")).toEqual([]);
    expect(problems('packages/b/src/flag.ts', 'const on = /^(?:true|false)$/i;')).toEqual([expect.stringMatching(/^packages\/b\/src\/flag\.ts: a switch is read as text/)]);
  });

  it("finds a compare of a variable with the word, and leaves the specification's own switch alone", () => {
    expect(problems('packages/a/src/config.ts', "resolve: (e) => ({ on: e.FEATURE_ON === 'true' })")).toHaveLength(1);
    expect(problems('packages/a/src/config.ts', "resolve: (e) => ({ on: e.FEATURE_ON.toLowerCase() === 'true' })")).toHaveLength(1);
    expect(problems('packages/a/src/config.ts', "resolve: (e) => ({ on: 'true' === e.FEATURE_ON })")).toHaveLength(1);
    expect(problems('packages/otel/src/index.ts', "disabled: e.OTEL_SDK_DISABLED.toLowerCase() === 'true'")).toEqual([]);
    expect(problems('packages/a/src/config.ts', "const same = e.MODE === 'strict'")).toEqual([]);
  });
});
