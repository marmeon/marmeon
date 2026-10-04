import { defineSolutions, ErrorSolutions, Logger, Redactor, token, type Application, type ServiceProvider } from '@bespokecore/core';
import { DevtoolsClearCommand, DevtoolsPruneCommand } from './commands.ts';
import { DevtoolsConfig, DevtoolsConfigError, loadDevtoolsOptions, resolveOptions, type ResolvedDevtoolsOptions } from './config.ts';
import { FileStore } from './file-store.ts';
import { Recorder } from './recorder.ts';
import { DevtoolsStore, MemoryStore } from './store.ts';
import { DevtoolsTestOptIn } from './testing.ts';

/** The link to the devtools in development documents — plain HTML outside the app's root, no script. */
export const DEV_LINK =
  '<a href="/_bespoke/devtools" data-bespoke-devtools title="BespokeCore devtools — development only" style="position:fixed;right:12px;bottom:12px;z-index:2147483646;padding:5px 10px;border-radius:999px;background:#1c1f24;color:#fff;font:600 12px/1.2 system-ui,sans-serif;text-decoration:none;opacity:.7">Devtools</a>';

/** The settings the recorder runs with — bound only where it runs. */
export const DevtoolsSettings = token<ResolvedDevtoolsOptions>('DevtoolsSettings');

/**
 * The devtools (E115, fail closed): with `NODE_ENV=development` — and only then — it loads `config/devtools.ts`, opens the
 * store (`storage/framework/devtools/`, shared with the worker and the scheduler `bespoke dev` starts, E101) and starts the
 * {@link Recorder}. Anywhere else nothing is subscribed, nothing written, `config/devtools.ts` never loaded;
 * `DEVTOOLS_ENABLED=true` with `NODE_ENV=production` fails the start. Tests opt in with `createTestApp(App, { devtools: true })`.
 * The commands `devtools:clear` and `devtools:prune` exist everywhere (they only remove files). Found by `bespoke discover` —
 * install it as a dev dependency, so production installs do not even have it.
 */
export class DevtoolsServiceProvider implements ServiceProvider {
  static config = [DevtoolsConfig];
  /** On the error page and when `bespoke` cannot start the app (E130). */
  static solutions = defineSolutions([
    {
      for: DevtoolsConfigError,
      when: (e) => e.message.includes('NODE_ENV=production'),
      solve: () => ({
        title: 'Remove DEVTOOLS_ENABLED in production',
        text: 'The devtools run with NODE_ENV=development only (E115) — nothing can turn them on in production. Remove DEVTOOLS_ENABLED from the environment, and install @bespokecore/devtools as a dev dependency (pnpm add -D @bespokecore/devtools): a production install then does not even have it.',
        docs: 'packages/devtools/README.md#only-in-development-e115-fail-closed',
      }),
    },
    {
      for: DevtoolsConfigError,
      when: (e) => e.message.startsWith('config/devtools.ts') || e.message.startsWith('defineDevtools'),
      solve: () => ({
        title: 'Fix config/devtools.ts',
        text: 'config/devtools.ts exports its settings as default: export default defineDevtools({ … }) — with what record, ignore, slowQueryMs, logLevel and storage take.',
        docs: 'packages/devtools/README.md#settings-configdevtoolsts-optional',
      }),
    },
  ]);

  #recorder: Recorder | undefined;

  async boot(app: Application): Promise<void> {
    const cli = await import('@bespokecore/cli').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) app.container.make(cli.CommandRegistry).add([DevtoolsClearCommand, DevtoolsPruneCommand]);

    const config = app.container.make(DevtoolsConfig);
    const test = app.container.has(DevtoolsTestOptIn) ? app.container.make(DevtoolsTestOptIn) : undefined;
    if (test && config.environment === 'production') {
      throw new DevtoolsConfigError('The devtools were opted in (createTestApp(…, { devtools: true })) with NODE_ENV=production — they never run in production (E115).');
    }
    if (config.ineffective && !test) {
      app.container.make(Logger).warn(`DEVTOOLS_ENABLED=true has no effect with NODE_ENV=${config.environment ?? '(unset)'}: the devtools run with NODE_ENV=development only (E115).`);
    }
    if (!config.enabled && !test) return;

    const options = resolveOptions(test ? {} : await loadDevtoolsOptions(app.root), app.root);
    const store: DevtoolsStore = test
      ? test.store
      : options.storage.driver === 'memory'
        ? new MemoryStore()
        : new FileStore({ directory: options.storage.path, maxBytes: options.storage.maxBytes, maxAgeHours: options.storage.maxAgeHours });
    // The ring starts within its limits (files of yesterday's session go now, not with the first write).
    if (store instanceof FileStore) await store.prune();
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

    // The pages under /_bespoke/devtools (W7 step 8): registered only here — in production the routes do not exist (E115).
    const { registerDevtoolsPages } = await import('./pages/index.ts');
    await registerDevtoolsPages({
      app,
      store,
      redactor: app.container.has(Redactor) ? app.container.make(Redactor) : new Redactor(),
      hosts: config.hosts,
      ...(store instanceof FileStore ? { maxBytes: options.storage.maxBytes } : {}),
    });
    // A link to them at the bottom of every page `bespoke dev` renders — HTML the dev renderer adds to the document (never a
    // client chunk; the in-page bar of step 9 takes its place). Bound by @bespokecore/server only with NODE_ENV=development.
    const server = await import('@bespokecore/server').catch(() => undefined);
    if (server && app.container.has(server.DevDocument)) app.container.make(server.DevDocument).add(DEV_LINK);
  }

  async shutdown(): Promise<void> {
    const recorder = this.#recorder;
    this.#recorder = undefined;
    await recorder?.close();
  }
}
