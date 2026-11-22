import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Application, Container, createApplication, listen, Logger, providerJobs, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { silent } from './__fixtures__/targets.ts';
import { checkTimeouts, QueueConnections } from './connections.ts';
import type { QueueDriverFactory } from './driver.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, type JobClass } from './index.ts';
import { addFromProvider, JobRegistry, providerSourceOf } from './registry.ts';

// A provider brings jobs with `static [providerJobs]`: the app lists them nowhere, a worker runs them, and every check of a module's
// jobs (duplicate names, the framework's prefix, encryption, timeouts) sees them too.

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

const handled: string[] = [];

/** A job class with its own name. */
function jobClass(name: string, statics: Record<string, unknown> = {}, label = 'Job'): JobClass {
  const Job = class {
    static readonly job = name;
    static readonly schema = v.object({ text: v.optional(v.string()) });
    handle(payload: { text?: string }): void {
      handled.push(`${name}:${payload.text ?? ''}`);
    }
  };
  Object.defineProperty(Job, 'name', { value: label });
  for (const [key, value] of Object.entries(statics)) Object.defineProperty(Job, key, { value });
  return Job as unknown as JobClass;
}

/** A provider class with a name and statics, as a package's would have them. */
function providerOf(name: string, statics: Record<string | symbol, unknown>, hooks = false): ServiceProviderClass {
  const Provider = class {
    // Without a hook, the statics alone must make the provider valid (K9).
    register = hooks ? () => {} : undefined;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  // The statics are given with their own keys, the symbol `[providerJobs]` included. A plain string `jobs` goes through plainJobs().
  for (const key of Reflect.ownKeys(statics)) Object.defineProperty(Provider, key, { value: statics[key as string] });
  return Provider as unknown as ServiceProviderClass;
}

/** A provider class with a plain string static named `jobs` — nothing the queue reads. */
function plainJobs(name: string, descriptor: PropertyDescriptor, hooks = true, key = 'jobs'): ServiceProviderClass {
  const Provider = class {
    register = hooks ? () => {} : undefined;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  Object.defineProperty(Provider, key, descriptor);
  return Provider as unknown as ServiceProviderClass;
}

const memory: QueueDriverFactory = ({ clock }) => ({ driver: new MemoryQueueDriver({ clock }), queue: 'default', retryAfterSeconds: 90 });
const MemoryDriver = providerOf('MemoryDriver', { queueDrivers: { 'memory-x': memory } });

function boot(providers: ServiceProviderClass[], options: { modules?: ModuleDefinition[]; encryption?: boolean; root?: string; discover?: boolean } = {}): Promise<Application> {
  return createApplication(
    {
      root: options.root ?? '/tmp',
      discover: options.discover ?? false,
      providers: [...(options.encryption ? [EncryptionServiceProvider] : []), QueueServiceProvider, MemoryDriver, ...providers],
      modules: options.modules ?? [],
    },
    { env: { APP_KEY: KEY, NODE_ENV: 'test', QUEUE_DRIVER: 'memory-x', QUEUE_FAILED_DRIVER: 'null' }, override: (container) => container.instance(Logger, silent) },
  );
}

/** Dispatches `job` and runs it on a real worker: reserved from the driver, built through the container, `handle()` called by the runner. */
async function dispatchAndWork(app: Application, job: JobClass, payload: object = { text: 'hi' }) {
  await app.container.make(Queue).dispatch(job as never, payload as never);
  expect(await app.container.make(Queue).size()).toBe(1);
  const result = await app.container.make(QueueConnections).worker('memory-x', 10).run({ queues: ['default'], stopWhenEmpty: true });
  expect(await app.container.make(Queue).size()).toBe(0);
  return result;
}

describe('the jobs of a provider', () => {
  it('are run by a real worker when the app hands the provider in', async () => {
    handled.length = 0;
    const Job = jobClass('pkg.by-hand');
    await using app = await boot([providerOf('HandProvider', { [providerJobs]: [Job] })]);
    const result = await dispatchAndWork(app, Job);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(handled).toEqual(['pkg.by-hand:hi']);
  });

  it("are run by a real worker when a module's provider brings them", async () => {
    handled.length = 0;
    const Job = jobClass('pkg.of-module');
    await using app = await boot([], { modules: [{ name: 'billing', providers: [providerOf('BillingProvider', { [providerJobs]: [Job] })] } as ModuleDefinition] });
    expect(app.providers.map((Provider) => Provider.name)).toContain('BillingProvider');
    const result = await dispatchAndWork(app, Job);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(handled).toEqual(['pkg.of-module:hi']);
  });

  it('are run by a real worker when an installed package brings them (discovered)', async () => {
    handled.length = 0;
    const root = tempDir('marmeon-provider-jobs-');
    const write = (dir: string, file: string, content: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), content);
    };
    write(root, 'package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: { '@acme/jobs': '1.0.0' } }));
    const pkg = join(root, 'node_modules/@acme/jobs');
    write(pkg, 'package.json', JSON.stringify({ name: '@acme/jobs', version: '1.0.0', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } }, marmeon: { providers: ['AcmeJobsServiceProvider'] } }));
    write(
      pkg,
      'index.js',
      `export class AcmeJob {
  static job = 'acme.discovered';
  static schema = { '~standard': { version: 1, vendor: 'acme', validate: (value) => ({ value }) } };
  handle(payload) { globalThis.__acmeJobSaw = payload.text; }
}
export class AcmeJobsServiceProvider {
  static [Symbol.for('marmeon.provider.jobs')] = [AcmeJob];
}
`,
    );
    write(pkg, 'index.d.ts', 'export declare class AcmeJob { handle(payload: { text: string }): void; }\nexport declare class AcmeJobsServiceProvider {}\n');
    await using app = await boot([], { root, discover: true });
    const { AcmeJob } = (await import(join(pkg, 'index.js'))) as { AcmeJob: JobClass };
    expect(app.providers.map((Provider) => Provider.name)).toContain('AcmeJobsServiceProvider');
    const result = await dispatchAndWork(app, AcmeJob);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect((globalThis as { __acmeJobSaw?: string }).__acmeJobSaw).toBe('hi');
    delete (globalThis as { __acmeJobSaw?: string }).__acmeJobSaw;
  });

  it('are the only thing a provider needs: it starts with and without the queue provider', async () => {
    const Only = providerOf('OnlyJobs', { [providerJobs]: [jobClass('pkg.only')] });
    await expect(boot([Only])).resolves.toBeDefined();
    await using app = await createApplication({ root: '/tmp', discover: false, providers: [Only] }, { env: { NODE_ENV: 'test' } });
    expect(app.providers).toContain(Only);
  });

  it('are registered by the time another provider boots before the queue provider does', async () => {
    const Job = jobClass('pkg.early');
    const seen: string[] = [];
    const Early = class {
      boot(app: Application): void {
        seen.push(...app.container.make(JobRegistry).all().map((job) => job.job));
      }
    };
    await using app = await createApplication(
      { root: '/tmp', discover: false, providers: [Early as unknown as ServiceProviderClass, QueueServiceProvider, MemoryDriver, providerOf('Late', { [providerJobs]: [Job] })], modules: [] },
      { env: { NODE_ENV: 'test', QUEUE_DRIVER: 'memory-x', QUEUE_FAILED_DRIVER: 'null' }, override: (container) => container.instance(Logger, silent) },
    );
    expect(seen).toEqual(['pkg.early']);
    expect(app.container.make(JobRegistry).has(Job)).toBe(true);
  });

  it('are run by QueueFake.work()', async () => {
    handled.length = 0;
    const Job = jobClass('pkg.fake');
    await using app = await boot([providerOf('FakeProvider', { [providerJobs]: [Job] })]);
    const fake = new QueueFake(app.container);
    await fake.dispatch(Job as never, { text: 'fake' } as never);
    await fake.work();
    expect(handled).toEqual(['pkg.fake:fake']);
  });

  it('are never given options: a provider cannot add a job named under marmeon., also with static framework, a framework property, or the framework provider name', async () => {
    const Plain = jobClass('marmeon.x', {}, 'TakesFramework');
    const Flagged = jobClass('marmeon.x', { framework: true }, 'TakesFramework');
    const OnList = Object.assign([jobClass('marmeon.x', {}, 'TakesFramework')], { framework: true });
    await expect(boot([providerOf('Impostor', { [providerJobs]: [Plain] })])).rejects.toThrow(/TakesFramework \(provider Impostor\) is named "marmeon\.x" — names under "marmeon\." belong to the framework/);
    await expect(boot([providerOf('Impostor', { [providerJobs]: [Flagged] })])).rejects.toThrow(/belong to the framework/);
    await expect(boot([providerOf('Impostor', { [providerJobs]: OnList })])).rejects.toThrow(/belong to the framework/);
    await expect(boot([providerOf('QueueServiceProvider', { [providerJobs]: [Plain] })])).rejects.toThrow(/provider QueueServiceProvider\) is named "marmeon\.x"/);
  });

  it("refuse a stand-in for the framework's job class through a provider's static, and when the framework registered it first (SendQueuedMail itself: see the mail package's test)", async () => {
    const SendQueuedMail = jobClass('marmeon.mail', { encrypted: true }, 'SendQueuedMail');
    await expect(boot([providerOf('Thief', { [providerJobs]: [SendQueuedMail] })])).rejects.toThrow(/SendQueuedMail \(provider Thief\) is named "marmeon\.mail" — names under "marmeon\." belong to the framework/);
    const registry = new JobRegistry().add([SendQueuedMail], '@marmeon/mail', { framework: true });
    expect(() => addFromProvider(registry, [SendQueuedMail], 'provider Thief')).toThrow(/belong to the framework/);
    expect(registry.has(SendQueuedMail)).toBe(true);
    expect(providerSourceOf(registry, SendQueuedMail)).toBeUndefined();
  });

  it('refuse a marmeon. job of a provider that has static framework = true itself', async () => {
    const Job = jobClass('marmeon.own', {}, 'OwnJob');
    await expect(boot([providerOf('Pretender', { [providerJobs]: [Job], framework: true })])).rejects.toThrow(/OwnJob \(provider Pretender\) is named "marmeon\.own"/);
  });

  it('refuse two different classes with one .name and one job name, as two copies of a package are', async () => {
    const First = jobClass('pkg.twin', {}, 'TwinJob');
    const Second = jobClass('pkg.twin', {}, 'TwinJob');
    expect(First).not.toBe(Second);
    await expect(boot([providerOf('CopyOne', { [providerJobs]: [First] }), providerOf('CopyTwo', { [providerJobs]: [Second] })])).rejects.toThrow(
      /Two jobs are named "pkg\.twin": TwinJob \(provider CopyOne\) and TwinJob \(provider CopyTwo\)\..*two copies of one package/,
    );
  });

  it('refuse a name another provider or a module has, naming both sources', async () => {
    const First = jobClass('pkg.same', {}, 'FirstJob');
    const Second = jobClass('pkg.same', {}, 'SecondJob');
    await expect(boot([providerOf('FirstProvider', { [providerJobs]: [First] }), providerOf('SecondProvider', { [providerJobs]: [Second] })])).rejects.toThrow(
      /Two jobs are named "pkg\.same": FirstJob \(provider FirstProvider\) and SecondJob \(provider SecondProvider\)\..*two copies of one package/,
    );
    await expect(boot([providerOf('SecondProvider', { [providerJobs]: [Second] })], { modules: [{ name: 'billing', jobs: [First] }] })).rejects.toThrow(
      /Two jobs are named "pkg\.same": FirstJob \(module billing\) and SecondJob \(provider SecondProvider\)/,
    );
  });

  it('refuse a subclass of a job, listed by two providers, that keeps the name of its parent', async () => {
    const Parent = jobClass('pkg.parent');
    class Child extends (Parent as unknown as new () => object) {}
    await expect(boot([providerOf('First', { [providerJobs]: [Parent] }), providerOf('Second', { [providerJobs]: [Child] })])).rejects.toThrow(/Two jobs are named "pkg\.parent"/);
  });

  it.each([
    ['null', null],
    ['an object', { first: jobClass('pkg.in-object') }],
    ['a string', 'ProcessMediaJob'],
    ['a number', 3],
    ['a function', () => []],
  ])('refuse a static [providerJobs] that is %s, naming the provider and the form to write', async (_label, value) => {
    await expect(boot([providerOf('MediaServiceProvider', { [providerJobs]: value }, true)])).rejects.toThrow(
      /^\[marmeon:Q4\] MediaServiceProvider has a static \[providerJobs\] that is not a list of job classes\. Write static \[providerJobs\] = \[ProcessMediaJob\]\./,
    );
  });

  it('refuse an unnamed provider with a static that is no list', async () => {
    const Unnamed = providerOf('', { [providerJobs]: 'x' }, true);
    await expect(boot([Unnamed])).rejects.toThrow(/\(unnamed\) has a static \[providerJobs\]/);
  });

  it('refuse an entry that is no class, naming the index and the kind and never the value', async () => {
    const hint = /Write static \[providerJobs\] = \[ProcessMediaJob\]\./;
    const marker = ['secret', 'marker', '1234'].join('-');
    const error = await boot([providerOf('Careless', { [providerJobs]: [jobClass('pkg.fine'), marker] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/^\[marmeon:Q4\] Careless lists a value of type string at static \[providerJobs\]\[1\], which is not a job class\./);
    expect((error as Error).message).toMatch(hint);
    expect((error as Error).message).not.toContain(marker);
    await expect(boot([providerOf('Careless', { [providerJobs]: [null] })])).rejects.toThrow(/lists a value of type null at static \[providerJobs\]\[0\]/);
    await expect(boot([providerOf('Careless', { [providerJobs]: [undefined] })])).rejects.toThrow(/lists a value of type undefined at static \[providerJobs\]\[0\]/);
    // A null-prototype object has no toString: it is refused by its kind, with no TypeError.
    await expect(boot([providerOf('Careless', { [providerJobs]: [Object.create(null)] })])).rejects.toThrow(/^\[marmeon:Q4\] Careless lists a value of type object at static \[providerJobs\]\[0\]/);
    // A hole in the list is an entry as well.
    const holey = [jobClass('pkg.fine'), jobClass('pkg.hole'), jobClass('pkg.other')];
    delete holey[1];
    expect(1 in holey).toBe(false);
    await expect(boot([providerOf('Careless', { [providerJobs]: holey })])).rejects.toThrow(/lists a value of type undefined at static \[providerJobs\]\[1\]/);
  });

  it('boots a valid encrypted job whose static name is a symbol, and prints no source for a static name() method', async () => {
    const Symbolic = jobClass('pkg.symbolic', { encrypted: true, name: Symbol('x') }, 'Ignored');
    await expect(boot([providerOf('SymbolProvider', { [providerJobs]: [Symbolic] })], { encryption: true })).resolves.toBeDefined();
    await expect(boot([providerOf('SymbolProvider', { [providerJobs]: [Symbolic] })])).rejects.toThrow(/\(unnamed class\) \(pkg\.symbolic, provider SymbolProvider\) is one\./);
    const First = jobClass('pkg.method', { name: () => 'method-source-marker' });
    const Second = jobClass('pkg.method', { name: () => 'method-source-marker' });
    const error = await boot([providerOf('A', { [providerJobs]: [First] }), providerOf('B', { [providerJobs]: [Second] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('Two jobs are named "pkg.method": (unnamed class) (provider A) and (unnamed class) (provider B).');
    expect((error as Error).message).not.toContain('method-source-marker');
  });

  it('refuse a class without name static, printing neither its source nor a made-up name', async () => {
    const Anonymous = (() => class { handle(): string { return 'class-source-marker'; } })();
    Object.defineProperty(Anonymous, 'name', { value: '' });
    const error = await boot([providerOf('Careless', { [providerJobs]: [Anonymous] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/\(unnamed class\) \(provider Careless\) needs a stable name/);
    expect((error as Error).message).not.toContain('class-source-marker');
  });

  it('refuse a class entry with a wrong tries, timeout, backoff or middleware, naming the job and the provider', async () => {
    const wrong = (statics: Record<string, unknown>) => boot([providerOf('Careless', { [providerJobs]: [jobClass('pkg.wrong', statics, 'WrongJob')] })]);
    await expect(wrong({ tries: 0 })).rejects.toThrow('WrongJob (pkg.wrong, provider Careless): static tries must be a whole number ≥ 1, not 0.');
    await expect(wrong({ timeout: -1 })).rejects.toThrow('WrongJob (pkg.wrong, provider Careless): static timeout must be seconds > 0');
    await expect(wrong({ backoff: 'soon' })).rejects.toThrow('WrongJob (pkg.wrong, provider Careless): static backoff must be seconds ≥ 0');
    await expect(wrong({ middleware: [{}] })).rejects.toThrow('WrongJob (pkg.wrong, provider Careless): static middleware must be a list of job middleware');
  });

  it('refuse an entry without a schema', async () => {
    class NoSchema {
      static readonly job = 'pkg.no-schema';
      handle() {}
    }
    await expect(boot([providerOf('Careless', { [providerJobs]: [NoSchema] })])).rejects.toThrow(/NoSchema \(pkg\.no-schema, provider Careless\) needs static schema/);
  });

  it('register nothing for a jobs field of an instance, plain or under the symbol', async () => {
    const Job = jobClass('pkg.instance-field');
    const Provider = class {
      jobs = [Job];
      [providerJobs] = [Job];
      register(): void {}
    };
    Object.defineProperty(Provider, 'name', { value: 'InstanceProvider' });
    await using app = await boot([Provider as unknown as ServiceProviderClass]);
    expect(app.container.make(JobRegistry).all()).toEqual([]);
  });

  it('refuse an encrypted job when the app has no Encrypter, naming the job and its provider', async () => {
    const Secret = jobClass('pkg.secret', { encrypted: true }, 'SecretJob');
    const Pkg = providerOf('SecretProvider', { [providerJobs]: [Secret] });
    await expect(boot([Pkg])).rejects.toThrow(/An encrypted job \(static encrypted\) needs the EncryptionServiceProvider of @marmeon\/encryption and an APP_KEY — SecretJob \(pkg\.secret, provider SecretProvider\) is one\./);
    await expect(boot([Pkg], { encryption: true })).resolves.toBeDefined();
  });

  it('refuse a queued listener without an Encrypter in the old words, naming no job', async () => {
    class Paid {
      static readonly event = 'shop.paid';
      static readonly schema = v.object({});
    }
    class Note {
      static readonly listener = 'shop.note-paid';
      static readonly queue = {};
      handle(): void {}
    }
    const error = await boot([], { modules: [{ name: 'shop', listeners: [listen(Paid as never, Note as never)] }] }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('[marmeon:Q4] An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY — every queued listener (static queue) is one.');
  });

  it("refuse a worker for a timeout the connection cannot hold, naming the job's provider", async () => {
    const Slow = jobClass('pkg.slow', { timeout: 100 }, 'SlowJob');
    await using app = await boot([providerOf('SlowProvider', { [providerJobs]: [Slow] })]);
    expect(() => app.container.make(QueueConnections).worker('memory-x', 10)).toThrow(/pkg\.slow \(timeout 100s, provider SlowProvider\)/);
  });

  it('start when the same class comes from a module and a provider, from one provider twice, or from a parent and its subclass', async () => {
    const Job = jobClass('pkg.shared');
    const Provider = providerOf('Shared', { [providerJobs]: [Job] });
    class Child extends (Provider as unknown as new () => object) {}
    await using app = await boot([Provider, Provider, Child as unknown as ServiceProviderClass], { modules: [{ name: 'billing', jobs: [Job] }] });
    expect(app.container.make(JobRegistry).all()).toEqual([Job]);
    expect(providerSourceOf(app.container.make(JobRegistry), Job)).toBeUndefined();
  });

  it('let classes with one .name and different job names live side by side', async () => {
    handled.length = 0;
    const One = jobClass('pkg.one', {}, 'SendJob');
    const Two = jobClass('pkg.two', {}, 'SendJob');
    await using app = await boot([providerOf('SameName', { [providerJobs]: [One] }), providerOf('SameName', { [providerJobs]: [Two] })]);
    expect(One.name).toBe(Two.name);
    await dispatchAndWork(app, One);
    await dispatchAndWork(app, Two);
    expect(handled).toEqual(['pkg.one:hi', 'pkg.two:hi']);
  });
});

describe('the released messages of jobs that no provider static brings', () => {
  const retry = (list: string, connection = 'database', retryAfter = 130, stop = 10) =>
    `[marmeon:Q4] The queue connection "${connection}" gives a claimed job ${retryAfter}s (retryAfterSeconds) before another worker may take it, but ${list} may hold it ` +
    `for its timeout plus the worker's --stop-timeout of ${stop}s — a second worker would run it while the first still does. ` +
    `Raise retryAfterSeconds (e.g. QUEUE_DATABASE_RETRY_AFTER_SECONDS) above timeout + stop timeout, or lower the job's static timeout.`;
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  it('names a module job in the timeout list by its name and timeout only, and a provider job with its provider', () => {
    const fromModule = jobClass('m.slow', { timeout: 120 });
    const fromProvider = jobClass('p.slow', { timeout: 125 });
    expect(messageOf(() => checkTimeouts(new JobRegistry().add([fromModule], 'module m'), 'database', 130, 10))).toBe(retry('m.slow (timeout 120s)'));
    expect(messageOf(() => checkTimeouts(addFromProvider(new JobRegistry().add([fromModule], 'module m'), [fromProvider], 'provider P'), 'database', 130, 10))).toBe(
      retry('m.slow (timeout 120s), p.slow (timeout 125s, provider P)'),
    );
    // A provider replaces nothing: a job a module lists and a provider lists again is the module's.
    expect(messageOf(() => checkTimeouts(addFromProvider(new JobRegistry().add([fromModule], 'module m'), [fromModule], 'provider P'), 'database', 130, 10))).toBe(retry('m.slow (timeout 120s)'));
  });

  it('refuses an encrypted job of a module without an Encrypter in the released words, also when a provider lists that class again', async () => {
    const message = '[marmeon:Q4] An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY — every queued listener (static queue) is one.';
    const Secret = jobClass('pkg.module-secret', { encrypted: true }, 'ModuleSecret');
    const error = await boot([], { modules: [{ name: 'billing', jobs: [Secret] }] }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(message);
    // A class a module lists and a provider lists again is the module's.
    const again = await boot([providerOf('Again', { [providerJobs]: [Secret] })], { modules: [{ name: 'billing', jobs: [Secret] }] }).catch((caught: unknown) => caught);
    expect((again as Error).message).toBe(message);
  });

  it('prints the framework prefix and duplicate refusals of module jobs, and of add(), in the released words', () => {
    const First = jobClass('pkg.same', {}, 'First');
    const Second = jobClass('pkg.same', {}, 'Second');
    const Nameless = jobClass('pkg.nameless', {}, '');
    const Framework = jobClass('marmeon.x', {}, 'Framework');
    expect(messageOf(() => new JobRegistry().add([First], 'module a').add([Second], 'module b'))).toBe(
      `[marmeon:Q4] Two jobs are named "pkg.same": First (module a) and Second (module b). A job's name is how the queue finds its class — give each its own static job.`,
    );
    expect(messageOf(() => new JobRegistry().add([Nameless], 'module a').add([Nameless, jobClass('pkg.nameless', {}, '')], 'package x'))).toBe(
      `[marmeon:Q4] Two jobs are named "pkg.nameless":  (package x) and  (package x). A job's name is how the queue finds its class — give each its own static job.`,
    );
    expect(messageOf(() => new JobRegistry().add([Framework], 'module a'))).toBe(
      '[marmeon:Q4] Framework (module a) is named "marmeon.x" — names under "marmeon." belong to the framework. Choose another static job.',
    );
    // With a provider's job among the two, the extra sentence and the safe names appear.
    expect(messageOf(() => addFromProvider(new JobRegistry().add([First], 'module a'), [Second], 'provider P'))).toBe(
      `[marmeon:Q4] Two jobs are named "pkg.same": First (module a) and Second (provider P). A job's name is how the queue finds its class — give each its own static job. Two classes with one name also come from an app that loads two copies of one package.`,
    );
  });

  it('prints the label and the refusals of checkJobClass in the released words, for module jobs and add()', () => {
    const Anonymous = (() => class { static job = 'Bad'; handle(): void {} })();
    Object.defineProperty(Anonymous, 'name', { value: '' });
    expect(messageOf(() => new JobRegistry().add([Anonymous as never], 'module x'))).toBe(
      `[marmeon:Q4] ${String(Anonymous)} (module x) needs a stable name: static job = 'module.what-it-does' (lower case; letters, digits and . - _ : between parts) — never the class name, which changes with refactoring. "Bad" is not one.`,
    );
    expect(messageOf(() => new JobRegistry().add([3 as never], 'module x'))).toBe('[marmeon:Q4] module x lists 3 as a job, but it is not a class.');
    expect(messageOf(() => new JobRegistry().add([null as never], 'module x'))).toBe('[marmeon:Q4] module x lists null as a job, but it is not a class.');
    const wrong = (statics: Record<string, unknown>) => messageOf(() => new JobRegistry().add([jobClass('pkg.wrong', statics, 'WrongJob')], 'module x'));
    expect(wrong({ tries: 0 })).toBe('[marmeon:Q4] WrongJob: static tries must be a whole number ≥ 1, not 0.');
    expect(wrong({ timeout: -1 })).toBe('[marmeon:Q4] WrongJob: static timeout must be seconds > 0 or a duration like { minutes: 2 }, not -1.');
    expect(wrong({ backoff: 'soon' })).toBe('[marmeon:Q4] WrongJob: static backoff must be seconds ≥ 0 — a number, a duration like { minutes: 1 }, or a list like [10, { minutes: 1 }, 300].');
    expect(wrong({ middleware: [{}] })).toBe('[marmeon:Q4] WrongJob: static middleware must be a list of job middleware — objects with handle(context, next), like withoutOverlapping(…).');
  });

  it('names the last module of a class two modules list, and keeps a provider in mind only where one came first', () => {
    const Shared = jobClass('test.shared', {}, 'Shared');
    const Other = jobClass('test.shared', {}, 'Other');
    const modules = new JobRegistry().add([Shared], 'module a').add([Shared], 'module b');
    expect(() => modules.add([Other], 'module c')).toThrow(
      'Two jobs are named "test.shared": Shared (module b) and Other (module c). A job\'s name is how the queue finds its class — give each its own static job.',
    );
    expect(() => modules.add([Other], 'module c')).not.toThrow(/two copies/);
    const provided = addFromProvider(new JobRegistry(), [Shared], 'provider P').add([Shared], 'package');
    expect(providerSourceOf(provided, Shared)).toBe('provider P');
    const moduleFirst = addFromProvider(new JobRegistry().add([Shared], 'module a'), [Shared], 'provider P');
    expect(() => moduleFirst.add([Other], 'module c')).toThrow('Shared (module a) and Other (module c)');
    expect(providerSourceOf(moduleFirst, Shared)).toBeUndefined();
  });

  it("gives a provider's job a safe name in each refusal that names it", async () => {
    const unprintable = (name: string) => jobClass(name, { name: Symbol('unprintable') });
    expect(messageOf(() => addFromProvider(new JobRegistry(), [unprintable('marmeon.x')], 'provider P'))).toMatch(
      /^\[marmeon:Q4\] \(unnamed class\) \(provider P\) is named "marmeon\.x"/,
    );
    expect(messageOf(() => addFromProvider(new JobRegistry(), [unprintable('pkg.two')], 'provider P').add([jobClass('pkg.two', {}, 'B')], 'module m'))).toMatch(
      /\(unnamed class\) \(provider P\) and B \(module m\).*two copies of one package\.$/,
    );
    expect(messageOf(() => addFromProvider(new JobRegistry(), ['secret-entry' as never], 'provider P'))).toBe(
      '[marmeon:Q4] provider P lists a value of type string as a job, but it is not a class.',
    );
    const registered = unprintable('pkg.copy');
    await using app = await boot([providerOf('CopyProvider', { [providerJobs]: [registered] })]);
    await expect((app.container.make(Queue) as any).dispatch(jobClass('pkg.copy', {}, 'Copy'), {})).rejects.toThrow(
      'Copy is named "pkg.copy", but that name belongs to (unnamed class) in this app\'s jobs.',
    );
  });

  it("keeps main's text when a module's job with an empty name holds the name", async () => {
    const Nameless = jobClass('pkg.empty-name', {}, '');
    await using app = await boot([], { modules: [{ name: 'billing', jobs: [Nameless] }] });
    await expect(app.container.make(Queue).dispatch(jobClass('pkg.empty-name', {}, 'Other') as never, {} as never)).rejects.toThrow(
      'Other is named "pkg.empty-name", but that name belongs to  in this app\'s jobs.',
    );
  });

  it('keeps the dispatch and worker messages in the released words', async () => {
    await using app = await boot([]);
    await expect(app.container.make(Queue).dispatch(jobClass('pkg.lost', {}, 'LostJob') as never, {} as never)).rejects.toThrow(
      new RegExp(`^${'LostJob \\(pkg\\.lost\\) is not registered — a worker could not run it\\. Add it to its module: defineModule\\(\\{ jobs: \\[LostJob\\] \\}\\)\\.'}$`),
    );
    const record = JSON.stringify({ v: 1, uuid: crypto.randomUUID(), job: 'pkg.unknown', data: {}, tries: 1, backoff: [], dispatchedAt: 0 });
    const prepared = await app.container.make(QueueConnections).runner().prepare(record);
    expect(prepared).toMatchObject({ kind: 'foreign', reason: 'No job named "pkg.unknown" is registered in this app (a deploy in progress, or a module\'s jobs: [...] is missing it).' });
  });

  it('never reads the name of a provider that has no static [providerJobs]', async () => {
    const Quiet = class {
      register(): void {}
      static get name(): string {
        throw new Error('the name was read');
      }
    };
    await expect(boot([Quiet as unknown as ServiceProviderClass])).resolves.toBeDefined();
  });
});

describe('a plain static named jobs', () => {
  const Real = jobClass('pkg.plain', { encrypted: true }, 'PlainJob');
  const Marmeon = jobClass('marmeon.plain', {}, 'PlainFramework');
  const shapes: [string, PropertyDescriptor][] = [
    ['a list of strings', { value: ['ProcessMediaJob'] }],
    ['an object', { value: { a: 1 } }],
    ['null', { value: null }],
    ['a method', { value: () => [] }],
    ['a Set', { value: new Set([Real]) }],
    ['real job classes, one encrypted and one under marmeon.', { value: [Real, Marmeon] }],
    [
      'a getter that throws',
      {
        get() {
          throw new Error('the static was evaluated');
        },
      },
    ],
  ];

  const keys = ['jobs', 'providerJobs', 'marmeon.provider.jobs'];
  const cases = keys.flatMap((key) => shapes.map(([label, descriptor]) => [key, label, descriptor] as const));

  it.each(cases)('is never read by the queue: a string static named %s as %s starts without an Encrypter and registers nothing', async (key, _label, descriptor) => {
    await using app = await boot([plainJobs('Colliding', descriptor, true, key)]);
    const registry = app.container.make(JobRegistry);
    expect(registry.all()).toEqual([]);
    expect(registry.has(Real)).toBe(false);
    await expect(app.container.make(Queue).dispatch(Real as never, {} as never)).rejects.toThrow(
      'PlainJob (pkg.plain) is not registered — a worker could not run it. Add it to its module: defineModule({ jobs: [PlainJob] }).',
    );
  });

  it.each(keys)('brings nothing: a provider with nothing but a string static named %s is refused with K9 as before', async (key) => {
    await expect(boot([plainJobs('OnlyPlain', { value: [Real] }, false, key)])).rejects.toThrow(/^\[marmeon:K9\] OnlyPlain is listed as a service provider but has no register\(\)/);
  });

  it.each(keys)('is not read by core either: a string static named %s does not count for the provider check', async (key) => {
    await expect(createApplication({ root: '/tmp', discover: false, providers: [plainJobs('OnlyPlain', { value: [Real] }, false, key)] }, { env: { NODE_ENV: 'test' } })).rejects.toThrow('[marmeon:K9] OnlyPlain');
  });
});

describe('a provider written with a static block', () => {
  it('is dispatched and run by a real worker, the form an isolatedDeclarations build writes', async () => {
    handled.length = 0;
    const Job = jobClass('pkg.assigned');
    class Assigned {
      register(): void {}
      static {
        Object.assign(this, { [providerJobs]: [Job] satisfies readonly JobClass[] });
      }
    }
    await using app = await boot([Assigned as unknown as ServiceProviderClass]);
    const result = await dispatchAndWork(app, Job);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(handled).toEqual(['pkg.assigned:hi']);
  });
});

describe('the key of a provider\'s jobs', () => {
  it('is the symbol of Symbol.for, so a copy of the core agrees with this one', async () => {
    expect(providerJobs).toBe(Symbol.for('marmeon.provider.jobs'));
    handled.length = 0;
    const Job = jobClass('pkg.other-copy');
    const Provider = class {};
    Object.defineProperty(Provider, Symbol.for('marmeon.provider.jobs'), { value: [Job] });
    await using app = await boot([Provider as unknown as ServiceProviderClass]);
    expect(app.container.make(JobRegistry).has(Job)).toBe(true);
    await dispatchAndWork(app, Job);
    expect(handled).toEqual(['pkg.other-copy:hi']);
  });

  it('starts a provider with nothing else, with and without the queue provider', async () => {
    const Only = providerOf('OnlyKey', { [providerJobs]: [jobClass('pkg.only-key')] });
    await expect(boot([Only])).resolves.toBeDefined();
    await using app = await createApplication({ root: '/tmp', discover: false, providers: [Only] }, { env: { NODE_ENV: 'test' } });
    expect(app.providers).toContain(Only);
  });
});

describe('a registry that is not a JobRegistry, and an application stand-in', () => {
  const standIn = (registry: JobRegistry) => registry;

  /** An object with the members of every release, bound to a real registry — not a JobRegistry itself. */
  const lookalike = (): JobRegistry => {
    const inner = new JobRegistry();
    return { add: inner.add.bind(inner), get: inner.get.bind(inner), has: inner.has.bind(inner), all: inner.all.bind(inner) } as unknown as JobRegistry;
  };

  it('starts with an encrypted job and an Encrypter, and says main\'s words for a timeout and a dispatch refusal, with no TypeError', async () => {
    const Secret = jobClass('pkg.lookalike', { encrypted: true, timeout: 100 }, 'LookJob');
    const registry = lookalike();
    registry.add([Secret], 'module m');
    const run = async (encryption: boolean) =>
      createApplication(
        { root: '/tmp', discover: false, providers: [...(encryption ? [EncryptionServiceProvider] : []), QueueServiceProvider, MemoryDriver], modules: [] },
        {
          env: { APP_KEY: KEY, NODE_ENV: 'test', QUEUE_DRIVER: 'memory-x', QUEUE_FAILED_DRIVER: 'null' },
          override: (container) => {
            container.instance(Logger, silent);
            container.instance(JobRegistry, standIn(registry));
          },
        },
      );
    await using app = await run(true);
    expect(() => app.container.make(QueueConnections).worker('memory-x', 10)).toThrow(/but pkg\.lookalike \(timeout 100s\) may hold it/);
    await expect(app.container.make(Queue).dispatch(jobClass('pkg.lookalike', {}, 'Other') as never, {} as never)).rejects.toThrow(
      'Other is named "pkg.lookalike", but that name belongs to LookJob in this app\'s jobs.',
    );
    await expect(run(false)).rejects.toThrow('[marmeon:Q4] An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY — every queued listener (static queue) is one.');
  });

  it('builds the registry for an application stand-in that has only modules', () => {
    const registry = new QueueServiceProvider();
    const container = new Container();
    container.instance(Application, { modules: [] } as unknown as Application);
    registry.register(container);
    expect(container.make(JobRegistry).all()).toEqual([]);
  });
});
