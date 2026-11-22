import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, listen, Logger, type Application, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import type { QueueDriverFactory } from './driver.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, type JobClass } from './index.ts';
import { JobRegistry } from './registry.ts';

// A provider brings jobs with `static jobs`: the app lists them nowhere, a worker runs them, and every check of a module's
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
function providerOf(name: string, statics: Record<string, unknown>, hooks = false): ServiceProviderClass {
  const Provider = class {
    // Without a hook, the statics alone must make the provider valid (K9).
    register = hooks ? () => {} : undefined;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  for (const [key, value] of Object.entries(statics)) Object.defineProperty(Provider, key, { value });
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
    await using app = await boot([providerOf('HandProvider', { jobs: [Job] })]);
    const result = await dispatchAndWork(app, Job);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(handled).toEqual(['pkg.by-hand:hi']);
  });

  it("are run by a real worker when a module's provider brings them", async () => {
    handled.length = 0;
    const Job = jobClass('pkg.of-module');
    await using app = await boot([], { modules: [{ name: 'billing', providers: [providerOf('BillingProvider', { jobs: [Job] })] } as ModuleDefinition] });
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
  static jobs = [AcmeJob];
}
`,
    );
    write(pkg, 'index.d.ts', 'export declare class AcmeJob { handle(payload: { text: string }): void; }\nexport declare class AcmeJobsServiceProvider { static jobs: (typeof AcmeJob)[]; }\n');
    await using app = await boot([], { root, discover: true });
    const { AcmeJob } = (await import(join(pkg, 'index.js'))) as { AcmeJob: JobClass };
    expect(app.providers.map((Provider) => Provider.name)).toContain('AcmeJobsServiceProvider');
    const result = await dispatchAndWork(app, AcmeJob);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect((globalThis as { __acmeJobSaw?: string }).__acmeJobSaw).toBe('hi');
    delete (globalThis as { __acmeJobSaw?: string }).__acmeJobSaw;
  });

  it('are the only thing a provider needs: it starts with and without the queue provider', async () => {
    const Only = providerOf('OnlyJobs', { jobs: [jobClass('pkg.only')] });
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
      { root: '/tmp', discover: false, providers: [Early as unknown as ServiceProviderClass, QueueServiceProvider, MemoryDriver, providerOf('Late', { jobs: [Job] })], modules: [] },
      { env: { NODE_ENV: 'test', QUEUE_DRIVER: 'memory-x', QUEUE_FAILED_DRIVER: 'null' }, override: (container) => container.instance(Logger, silent) },
    );
    expect(seen).toEqual(['pkg.early']);
    expect(app.container.make(JobRegistry).has(Job)).toBe(true);
  });

  it('are run by QueueFake.work()', async () => {
    handled.length = 0;
    const Job = jobClass('pkg.fake');
    await using app = await boot([providerOf('FakeProvider', { jobs: [Job] })]);
    const fake = new QueueFake(app.container);
    await fake.dispatch(Job as never, { text: 'fake' } as never);
    await fake.work();
    expect(handled).toEqual(['pkg.fake:fake']);
  });

  it('are never given options: a provider cannot add a job named under marmeon., also with static framework, a framework property, or the framework provider name', async () => {
    const Plain = jobClass('marmeon.x', {}, 'TakesFramework');
    const Flagged = jobClass('marmeon.x', { framework: true }, 'TakesFramework');
    const OnList = Object.assign([jobClass('marmeon.x', {}, 'TakesFramework')], { framework: true });
    await expect(boot([providerOf('Impostor', { jobs: [Plain] })])).rejects.toThrow(/TakesFramework \(provider Impostor\) is named "marmeon\.x" — names under "marmeon\." belong to the framework/);
    await expect(boot([providerOf('Impostor', { jobs: [Flagged] })])).rejects.toThrow(/belong to the framework/);
    await expect(boot([providerOf('Impostor', { jobs: OnList })])).rejects.toThrow(/belong to the framework/);
    await expect(boot([providerOf('QueueServiceProvider', { jobs: [Plain] })])).rejects.toThrow(/provider QueueServiceProvider\) is named "marmeon\.x"/);
  });

  it("refuse a stand-in for the framework's job class through a provider's static, and when the framework registered it first (SendQueuedMail itself: see the mail package's test)", async () => {
    const SendQueuedMail = jobClass('marmeon.mail', { encrypted: true }, 'SendQueuedMail');
    await expect(boot([providerOf('Thief', { jobs: [SendQueuedMail] })])).rejects.toThrow(/SendQueuedMail \(provider Thief\) is named "marmeon\.mail" — names under "marmeon\." belong to the framework/);
    const registry = new JobRegistry().add([SendQueuedMail], '@marmeon/mail', { framework: true });
    expect(() => registry.add([SendQueuedMail], 'provider Thief')).toThrow(/belong to the framework/);
    expect(registry.sourceOf(SendQueuedMail)).toBe('@marmeon/mail');
  });

  it('refuse a marmeon. job of a provider that has static framework = true itself', async () => {
    const Job = jobClass('marmeon.own', {}, 'OwnJob');
    await expect(boot([providerOf('Pretender', { jobs: [Job], framework: true })])).rejects.toThrow(/OwnJob \(provider Pretender\) is named "marmeon\.own"/);
  });

  it('refuse two different classes with one .name and one job name, as two copies of a package are', async () => {
    const First = jobClass('pkg.twin', {}, 'TwinJob');
    const Second = jobClass('pkg.twin', {}, 'TwinJob');
    expect(First).not.toBe(Second);
    await expect(boot([providerOf('CopyOne', { jobs: [First] }), providerOf('CopyTwo', { jobs: [Second] })])).rejects.toThrow(
      /Two jobs are named "pkg\.twin": TwinJob \(provider CopyOne\) and TwinJob \(provider CopyTwo\)\..*two copies of one package/,
    );
  });

  it('refuse a name another provider or a module has, naming both sources', async () => {
    const First = jobClass('pkg.same', {}, 'FirstJob');
    const Second = jobClass('pkg.same', {}, 'SecondJob');
    await expect(boot([providerOf('FirstProvider', { jobs: [First] }), providerOf('SecondProvider', { jobs: [Second] })])).rejects.toThrow(
      /Two jobs are named "pkg\.same": FirstJob \(provider FirstProvider\) and SecondJob \(provider SecondProvider\)\..*two copies of one package/,
    );
    await expect(boot([providerOf('SecondProvider', { jobs: [Second] })], { modules: [{ name: 'billing', jobs: [First] }] })).rejects.toThrow(
      /Two jobs are named "pkg\.same": FirstJob \(module billing\) and SecondJob \(provider SecondProvider\)/,
    );
  });

  it('refuse a subclass of a job, listed by two providers, that keeps the name of its parent', async () => {
    const Parent = jobClass('pkg.parent');
    class Child extends (Parent as unknown as new () => object) {}
    await expect(boot([providerOf('First', { jobs: [Parent] }), providerOf('Second', { jobs: [Child] })])).rejects.toThrow(/Two jobs are named "pkg\.parent"/);
  });

  it.each([
    ['null', null],
    ['an object', { first: jobClass('pkg.in-object') }],
    ['a string', 'ProcessMediaJob'],
    ['a number', 3],
    ['a function', () => []],
  ])('refuse a static jobs that is %s, naming the provider and the form to write', async (_label, value) => {
    await expect(boot([providerOf('MediaServiceProvider', { jobs: value }, true)])).rejects.toThrow(
      /^\[marmeon:Q4\] MediaServiceProvider has a static jobs that is not a list of job classes\. Write static jobs = \[ProcessMediaJob\]; a static of your own needs another name\./,
    );
  });

  it('refuse an unnamed provider with a static that is no list', async () => {
    const Unnamed = providerOf('', { jobs: 'x' }, true);
    await expect(boot([Unnamed])).rejects.toThrow(/\(unnamed\) has a static jobs/);
  });

  it('refuse an entry that is no class, naming the index and the kind and never the value', async () => {
    const hint = /Write static jobs = \[ProcessMediaJob\]; a static of your own needs another name\./;
    const marker = ['secret', 'marker', '1234'].join('-');
    const error = await boot([providerOf('Careless', { jobs: [jobClass('pkg.fine'), marker] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/^\[marmeon:Q4\] Careless lists a value of type string at static jobs\[1\], which is not a job class\./);
    expect((error as Error).message).toMatch(hint);
    expect((error as Error).message).not.toContain(marker);
    await expect(boot([providerOf('Careless', { jobs: [null] })])).rejects.toThrow(/lists a value of type null at static jobs\[0\]/);
    await expect(boot([providerOf('Careless', { jobs: [undefined] })])).rejects.toThrow(/lists a value of type undefined at static jobs\[0\]/);
    // A null-prototype object has no toString: it is refused by its kind, with no TypeError.
    await expect(boot([providerOf('Careless', { jobs: [Object.create(null)] })])).rejects.toThrow(/^\[marmeon:Q4\] Careless lists a value of type object at static jobs\[0\]/);
    // A hole in the list is an entry as well.
    const holey = [jobClass('pkg.fine'), jobClass('pkg.hole'), jobClass('pkg.other')];
    delete holey[1];
    expect(1 in holey).toBe(false);
    await expect(boot([providerOf('Careless', { jobs: holey })])).rejects.toThrow(/lists a value of type undefined at static jobs\[1\]/);
  });

  it('refuse a class entry of a module that is no class, without printing a string value either', async () => {
    const marker = ['module', 'marker', '5678'].join('-');
    const error = await boot([], { modules: [{ name: 'billing', jobs: [marker as never] }] }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('module billing lists a value of type string as a job, but it is not a class.');
    expect((error as Error).message).not.toContain(marker);
  });

  it('boots a valid encrypted job whose static name is a symbol, and prints no source for a static name() method', async () => {
    const Symbolic = jobClass('pkg.symbolic', { encrypted: true, name: Symbol('x') }, 'Ignored');
    await expect(boot([providerOf('SymbolProvider', { jobs: [Symbolic] })], { encryption: true })).resolves.toBeDefined();
    await expect(boot([providerOf('SymbolProvider', { jobs: [Symbolic] })])).rejects.toThrow(/\(unnamed class\) \(pkg\.symbolic, provider SymbolProvider\) is one\./);
    const First = jobClass('pkg.method', { name: () => 'method-source-marker' });
    const Second = jobClass('pkg.method', { name: () => 'method-source-marker' });
    const error = await boot([providerOf('A', { jobs: [First] }), providerOf('B', { jobs: [Second] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('Two jobs are named "pkg.method": (unnamed class) (provider A) and (unnamed class) (provider B).');
    expect((error as Error).message).not.toContain('method-source-marker');
  });

  it('refuse a class without name static, printing neither its source nor a made-up name', async () => {
    const Anonymous = (() => class { handle(): string { return 'class-source-marker'; } })();
    Object.defineProperty(Anonymous, 'name', { value: '' });
    const error = await boot([providerOf('Careless', { jobs: [Anonymous] })]).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/\(unnamed class\) \(provider Careless\) needs a stable name/);
    expect((error as Error).message).not.toContain('class-source-marker');
  });

  it('refuse a class entry with a wrong tries, timeout, backoff or middleware, naming the job and the provider', async () => {
    const wrong = (statics: Record<string, unknown>) => boot([providerOf('Careless', { jobs: [jobClass('pkg.wrong', statics, 'WrongJob')] })]);
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
    await expect(boot([providerOf('Careless', { jobs: [NoSchema] })])).rejects.toThrow(/NoSchema \(pkg\.no-schema, provider Careless\) needs static schema/);
  });

  it('register nothing for a jobs field of an instance', async () => {
    const Job = jobClass('pkg.instance-field');
    const Provider = class {
      jobs = [Job];
      register(): void {}
    };
    Object.defineProperty(Provider, 'name', { value: 'InstanceProvider' });
    await using app = await boot([Provider as unknown as ServiceProviderClass]);
    expect(app.container.make(JobRegistry).all()).toEqual([]);
  });

  it('refuse an encrypted job when the app has no Encrypter, naming the job and its provider', async () => {
    const Secret = jobClass('pkg.secret', { encrypted: true }, 'SecretJob');
    const Pkg = providerOf('SecretProvider', { jobs: [Secret] });
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
    await using app = await boot([providerOf('SlowProvider', { jobs: [Slow] })]);
    expect(() => app.container.make(QueueConnections).worker('memory-x', 10)).toThrow(/pkg\.slow \(timeout 100s, provider SlowProvider\)/);
  });

  it('start when the same class comes from a module and a provider, from one provider twice, or from a parent and its subclass', async () => {
    const Job = jobClass('pkg.shared');
    const Provider = providerOf('Shared', { jobs: [Job] });
    class Child extends (Provider as unknown as new () => object) {}
    await using app = await boot([Provider, Provider, Child as unknown as ServiceProviderClass], { modules: [{ name: 'billing', jobs: [Job] }] });
    expect(app.container.make(JobRegistry).all()).toEqual([Job]);
    expect(app.container.make(JobRegistry).sourceOf(Job)).toBe('module billing');
  });

  it('let classes with one .name and different job names live side by side', async () => {
    handled.length = 0;
    const One = jobClass('pkg.one', {}, 'SendJob');
    const Two = jobClass('pkg.two', {}, 'SendJob');
    await using app = await boot([providerOf('SameName', { jobs: [One] }), providerOf('SameName', { jobs: [Two] })]);
    expect(One.name).toBe(Two.name);
    await dispatchAndWork(app, One);
    await dispatchAndWork(app, Two);
    expect(handled).toEqual(['pkg.one:hi', 'pkg.two:hi']);
  });
});

describe('jobs that the dispatch names', () => {
  it('name the static of a provider when a job is not registered', async () => {
    await using app = await boot([]);
    await expect(app.container.make(Queue).dispatch(jobClass('pkg.lost', {}, 'LostJob') as never, {} as never)).rejects.toThrow(
      /LostJob \(pkg\.lost\) is not registered — a worker could not run it\. Add it to its module: defineModule\(\{ jobs: \[LostJob\] \}\) \(a package lists it on its provider: static jobs = \[LostJob\]\)\./,
    );
  });

  it("name the static of a provider when a worker finds no class for a record", async () => {
    await using app = await boot([]);
    const record = JSON.stringify({ v: 1, uuid: crypto.randomUUID(), job: 'pkg.unknown', data: {}, tries: 1, backoff: [], dispatchedAt: 0 });
    const prepared = await app.container.make(QueueConnections).runner().prepare(record);
    expect(prepared).toMatchObject({
      kind: 'foreign',
      reason: `No job named "pkg.unknown" is registered in this app (a deploy in progress, or a module's jobs: [...] or a provider's static jobs is missing it).`,
    });
  });
});
