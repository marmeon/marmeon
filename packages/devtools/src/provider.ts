import { defineSolutions, ErrorSolutions, escapeHtml, Logger, Redactor, token, type Application, type ServiceProvider } from '@marmeon/core';
import { CSP_NONCE_PLACEHOLDER } from '@marmeon/core/internal';
import { DevtoolsClearCommand, DevtoolsPruneCommand } from './commands.ts';
import { DevtoolsConfig, DevtoolsSetupError, loadDevtoolsOptions, resolveOptions, type ResolvedDevtoolsOptions } from './config.ts';
import { FileDevtoolsStore } from './file-store.ts';
import { Recorder } from './recorder.ts';
import { DevtoolsStore, MemoryDevtoolsStore } from './store.ts';
import { DevtoolsTestOptIn } from './test-opt-in.ts';
import type { CommandClass } from 'marmeon';

/** Where the Vite dev server serves the in-page bar's client — never part of a build. */
export const BAR_SCRIPT = '/@id/@marmeon/devtools/client';

/**
 * The in-page bar in every development document's head: the document's request id (the bar asks the
 * server's record of it; escaped, a client may send its own `x-request-id`) and the module script of the bar, served by the Vite
 * dev server. In the head, it runs before the app's entry: its dev hook is there when the navigator is made. Its script carries the
 * nonce placeholder: under the app's `contentSecurityPolicy()` the renderer puts the response's nonce there.
 */
export function barMarkup({ requestId }: { readonly requestId: string | undefined }): string {
  return `<meta name="marmeon-devtools" content="${escapeHtml(requestId ?? '')}" data-marmeon-devtools>\n<script type="module" src="${BAR_SCRIPT}" nonce="${CSP_NONCE_PLACEHOLDER}" data-marmeon-devtools></script>`;
}

/** The settings the recorder runs with — bound only where it runs. */
export const DevtoolsSettings = token<ResolvedDevtoolsOptions>('DevtoolsSettings');

/**
 * The devtools (fail closed): with `NODE_ENV=development` — and only then — it loads `config/devtools.ts`, opens the
 * store (`storage/framework/devtools/`, shared with the worker and the scheduler `marmeon dev` starts) and starts the
 * {@link Recorder}. Anywhere else nothing is subscribed, nothing written, `config/devtools.ts` never loaded;
 * `DEVTOOLS_ENABLED=true` with `NODE_ENV=production` fails the start. Tests opt in with `createTestApp(App, { devtools: true })`.
 * The commands `devtools:clear` and `devtools:prune` exist everywhere (they only remove files). Found by `marmeon discover` —
 * install it as a dev dependency, so production installs do not even have it.
 */
export class DevtoolsServiceProvider implements ServiceProvider {
  static config = [DevtoolsConfig];
  static commands: readonly CommandClass[] = [DevtoolsClearCommand, DevtoolsPruneCommand];
  /** On the error page and when `marmeon` cannot start the app. */
  static solutions = defineSolutions([
    {
      for: DevtoolsSetupError,
      when: (e) => e.message.startsWith('DEVTOOLS_ENABLED is on with') || e.message.startsWith('The devtools were opted in'),
      solve: () => ({
        title: 'Remove DEVTOOLS_ENABLED in production',
        text: 'The devtools run with NODE_ENV=development only — nothing can turn them on in production or without NODE_ENV, whatever APP_ENV says. Remove DEVTOOLS_ENABLED from the environment, and install @marmeon/devtools as a dev dependency (pnpm add -E -D @marmeon/devtools@<version of your app>): a production install then does not even have it.',
        docs: 'docs/devtools.md#only-in-development',
      }),
    },
    {
      for: DevtoolsSetupError,
      when: (e) => e.message.startsWith('config/devtools.ts') || e.message.startsWith('defineDevtools'),
      solve: () => ({
        title: 'Fix config/devtools.ts',
        text: 'config/devtools.ts exports its settings as default: export default defineDevtools({ … }) — with what record, ignore, slowQueryMs, logLevel and storage take.',
        docs: 'docs/devtools.md#settings',
      }),
    },
  ]);

  #recorder: Recorder | undefined;

  async boot(app: Application): Promise<void> {
    const config = app.container.make(DevtoolsConfig);
    const test = app.container.has(DevtoolsTestOptIn) ? app.container.make(DevtoolsTestOptIn) : undefined;
    if (test && config.protected) {
      throw new DevtoolsSetupError(
        `The devtools were opted in (createTestApp(…, { devtools: true })) with NODE_ENV=${config.environment ?? '(unset)'} — they never run in production or without NODE_ENV.`,
      );
    }
    if (config.ineffective && !test) {
      app.container.make(Logger).warn(`DEVTOOLS_ENABLED is on, which has no effect with NODE_ENV=${config.environment ?? '(unset)'}: the devtools run with NODE_ENV=development only.`);
    }
    if (!config.enabled && !test) return;

    const options = resolveOptions(test ? {} : await loadDevtoolsOptions(app.root), app.root);
    const store: DevtoolsStore = test
      ? test.store
      : options.storage.driver === 'memory'
        ? new MemoryDevtoolsStore()
        : new FileDevtoolsStore({ directory: options.storage.path, maxBytes: options.storage.maxBytes, maxAgeHours: options.storage.maxAgeHours });
    // The ring starts within its limits (files of yesterday's session go now, not with the first write).
    if (store instanceof FileDevtoolsStore) await store.prune();
    app.container.instance(DevtoolsSettings, options);
    app.container.instance(DevtoolsStore, store);
    this.#recorder = new Recorder({
      app,
      store,
      redactor: app.container.has(Redactor) ? app.container.make(Redactor) : new Redactor(),
      options,
      ...(app.container.has(ErrorSolutions) ? { solutions: app.container.make(ErrorSolutions) } : {}),
    }).start();
    app.container.instance(Recorder, this.#recorder);

    // The pages under /_marmeon/devtools: registered only here — in production the routes do not exist.
    const { registerDevtoolsPages } = await import('./pages/index.ts');
    await registerDevtoolsPages({
      app,
      store,
      redactor: app.container.has(Redactor) ? app.container.make(Redactor) : new Redactor(),
      hosts: config.hosts,
      ...(store instanceof FileDevtoolsStore ? { maxBytes: options.storage.maxBytes } : {}),
    });
    // The in-page bar in every document `marmeon dev` renders: HTML the dev renderer adds to the document's head —
    // its client comes from the Vite dev server, never from a client chunk. Bound by @marmeon/server only with NODE_ENV=development.
    const server = await import('@marmeon/server/internal').catch(() => undefined);
    if (server && app.container.has(server.DevDocument)) app.container.make(server.DevDocument).add(barMarkup, { at: 'head' });
  }

  async shutdown(): Promise<void> {
    const recorder = this.#recorder;
    this.#recorder = undefined;
    await recorder?.close();
  }
}
