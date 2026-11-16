import { Application, Logger, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { allowedRanges } from './allowed.ts';
import { HttpClient } from './client.ts';
import { BUILT_IN_FETCH_DRIVERS, FetchConfig } from './config.ts';
import { DirectTransport } from './direct.ts';
import { FetchSetupError } from './errors.ts';
import { FetchTransport, type FetchDriverFactory } from './transport.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Fetch transports this provider brings, by name — `FETCH_DRIVER=<name>` selects one. A built-in name (`direct`) or a name another
     * provider brings stops the start.
     */
    readonly fetchDrivers?: Readonly<Record<string, FetchDriverFactory>>;
  }
}

/**
 * Registers the `HttpClient` and its `FetchTransport` (`FETCH_DRIVER`). The transport is built at the start, so a driver nobody
 * brought, a bad `FETCH_ALLOWED_ADDRESSES` or a factory that fails stops the start. Found by `marmeon discover`.
 */
export class FetchServiceProvider implements ServiceProvider {
  static config = [FetchConfig];

  /** The transport the boot built; closed at shutdown. */
  #transport: FetchTransport | undefined;

  register(container: Container): void {
    const config = container.make(FetchConfig);
    container.singleton(FetchTransport, (c) => {
      this.#transport = config.driver === 'direct' ? new DirectTransport() : this.#custom(config, c);
      return this.#transport;
    });
    container.singleton(HttpClient, (c) => new HttpClient({ transport: c.make(FetchTransport), allow: allowedRanges(config.allowedAddresses) }));
  }

  #factories(container: Resolver): ReadonlyMap<string, FetchDriverFactory> {
    return collectDrivers<FetchDriverFactory>(container.make(Application).providers, 'fetchDrivers', BUILT_IN_FETCH_DRIVERS, 'fetch driver');
  }

  /** The transport a provider's factory returns for `FETCH_DRIVER`; a name nobody brought is refused (a typo never lands on another transport). */
  #custom(config: FetchConfig, container: Resolver): FetchTransport {
    const factory = this.#factories(container).get(config.driver);
    if (!factory) throw this.#unknown(config.driver, container);
    const transport = factory({ name: config.driver, container, logger: container.make(Logger).child({ channel: 'fetch' }) });
    if (typeof (transport as Partial<FetchTransport> | undefined)?.send !== 'function') {
      throw new FetchSetupError(withCode('S9', `The fetch driver "${config.driver}" must return a FetchTransport: an object with send(request, context) that resolves with { status, headers, body }.`));
    }
    return transport;
  }

  #unknown(driver: string, container: Resolver): FetchSetupError {
    return new FetchSetupError(withCode('S9', `FETCH_DRIVER=${driver} is not a fetch driver. Known: ${[...BUILT_IN_FETCH_DRIVERS, ...this.#factories(container).keys()].join(', ')}.`));
  }

  boot(app: Application): void {
    // A bad range, a name nobody brought, a built-in name or a name twice, or a factory that fails stops the start here, not at the first request.
    // Checked whatever the `HttpClient` is bound to: a test app that swaps it for a fake starts under the same rules.
    allowedRanges(app.container.make(FetchConfig).allowedAddresses);
    this.#factories(app.container);
    app.container.make(FetchTransport);
    app.container.make(HttpClient);
  }

  async shutdown(): Promise<void> {
    await this.#transport?.close?.();
  }
}
