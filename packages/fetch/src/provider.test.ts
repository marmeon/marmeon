import { createApplication, ConfigError, Logger, type LogContext, type ServiceProviderClass } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { HttpClient } from './client.ts';
import { FetchConfig } from './config.ts';
import { FetchServiceProvider } from './provider.ts';
import { FetchTransport, type FetchDriverFactory, type TransportResponse } from './transport.ts';

const plugin = (name: string, fetchDrivers: Record<string, FetchDriverFactory> | undefined): ServiceProviderClass => ({ [name]: class { static fetchDrivers = fetchDrivers; } })[name]!;
const boot = (providers: ServiceProviderClass[], env: Record<string, string>) =>
  createApplication({ root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, ...providers] }, { env: { LOG_LEVEL: 'silent', ...env } });

const answer = (text: string): TransportResponse => ({
  status: 200,
  headers: new Headers(),
  body: new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
});

describe('FetchServiceProvider: FETCH_ALLOWED_ADDRESSES', () => {
  it('stops the start for an entry that is not a range, and names the entry', async () => {
    const error = await boot([], { FETCH_ALLOWED_ADDRESSES: '10.0.0.0/8, internal.example' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[marmeon:S9] FETCH_ALLOWED_ADDRESSES has an entry that is not an address range. "internal.example" is not an address range.');
  });

  it('stops the start for an empty entry between commas', async () => {
    await expect(boot([], { FETCH_ALLOWED_ADDRESSES: '10.0.0.0/8,,192.168.0.0/16' })).rejects.toThrow(/\[marmeon:S9\].*"" is not an address range/);
  });

  it('reads comma-separated ranges, and the default allows nothing', async () => {
    const seen: string[] = [];
    const spy: FetchDriverFactory = () => ({
      async send(request, context) {
        seen.push(`${request.url.hostname} ${context.isPublic('10.20.30.40')} ${context.isPublic('192.168.1.1')} ${context.isPublic('93.184.216.34')} ${context.isPublic('fd00::1')}`);
        return answer('ok');
      },
    });
    const allowed = await boot([plugin('SpyProvider', { spy })], { FETCH_DRIVER: 'spy', FETCH_ALLOWED_ADDRESSES: '10.20.0.0/16 , fd00::/8' });
    await allowed.container.make(HttpClient).fetch('http://one.test/');
    const none = await boot([plugin('SpyProvider', { spy })], { FETCH_DRIVER: 'spy' });
    await none.container.make(HttpClient).fetch('http://two.test/');
    expect(seen).toEqual(['one.test true false true true', 'two.test false false true false']);
  });
});

describe('FetchServiceProvider: FETCH_DRIVER', () => {
  const echo: FetchDriverFactory = ({ name }) => ({ send: async (request) => answer(`${name} ${request.url.href}`) });

  it('uses the transport a provider brings under that name, and hands the factory its name, container and logger', async () => {
    let seen: Record<string, unknown> = {};
    const channels: unknown[] = [];
    const spy: FetchDriverFactory = (context) => {
      seen = { ...context };
      context.logger.info('hello');
      channels.push(context.container.make(FetchConfig).driver);
      return echo(context);
    };
    const bindings: LogContext[] = [];
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: (context: LogContext) => (bindings.push(context), logger) };
    const app = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, plugin('EgressProvider', { egress: spy })] },
      { env: { LOG_LEVEL: 'silent', FETCH_DRIVER: 'egress' }, override: (container) => container.instance(Logger, logger) },
    );
    expect(bindings).toContainEqual({ channel: 'fetch' });
    expect(await (await app.container.make(HttpClient).fetch('http://example.test/a')).text()).toBe('egress http://example.test/a');
    expect(Object.keys(seen).sort()).toEqual(['container', 'logger', 'name']);
    expect(seen.name).toBe('egress');
    expect(channels).toEqual(['egress']);
  });

  it('uses the direct transport by default', async () => {
    const app = await boot([], {});
    expect(app.container.make(FetchTransport)).toBeDefined();
    const error = await app.container.make(HttpClient).fetch('http://127.0.0.1:9/').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'FetchError', reason: 'refused' });
  });

  it('stops the start for a name nobody brought, and lists the known ones', async () => {
    const error = await boot([plugin('EgressProvider', { egress: echo })], { FETCH_DRIVER: 'nope' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[marmeon:S9] FETCH_DRIVER=nope is not a fetch driver. Known: direct, egress.');
  });

  it('stops the start for a malformed name', async () => {
    await expect(boot([], { FETCH_DRIVER: 'No Way' })).rejects.toThrow(ConfigError);
  });

  it('refuses the built-in name, a name twice, and a factory that returns no transport', async () => {
    await expect(boot([plugin('EvilProvider', { direct: echo })], {})).rejects.toThrow(/belongs to the built-in one/);
    await expect(boot([plugin('One', { egress: echo }), plugin('Two', { egress: echo })], { FETCH_DRIVER: 'egress' })).rejects.toThrow(/brought by both One and Two/);
    const broken = (() => ({})) as unknown as FetchDriverFactory;
    await expect(boot([plugin('BrokenProvider', { broken })], { FETCH_DRIVER: 'broken' })).rejects.toThrow('[marmeon:S9] The fetch driver "broken" must return a FetchTransport');
  });

  it('closes the transport at shutdown', async () => {
    let closed = 0;
    const closing: FetchDriverFactory = () => ({ send: async () => answer(''), close: async () => void closed++ });
    const app = await boot([plugin('ClosingProvider', { closing })], { FETCH_DRIVER: 'closing' });
    await app.shutdown();
    expect(closed).toBe(1);
  });
});
