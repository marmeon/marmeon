import { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { DevtoolsConfig, loadDevtoolsOptions, resolveOptions } from './config.ts';
import { FileStore } from './file-store.ts';
import { DevtoolsStore } from './store.ts';

/**
 * The app's store — the recorder's, or (devtools off in this process) its files: where `config/devtools.ts` puts them in
 * development (`DEVTOOLS_ENABLED=false`), the default directory anywhere else — the app's devtools settings are loaded in
 * development only.
 */
async function storeOf(app: Application): Promise<DevtoolsStore> {
  if (app.container.has(DevtoolsStore)) return app.container.make(DevtoolsStore);
  const development = app.container.make(DevtoolsConfig).environment === 'development';
  const { storage } = resolveOptions(development ? await loadDevtoolsOptions(app.root) : {}, app.root);
  return new FileStore({ directory: storage.path, maxBytes: storage.maxBytes, maxAgeHours: storage.maxAgeHours });
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `marmeon devtools:clear`: removes every recorded entry (`storage/framework/devtools/`). */
export class DevtoolsClearCommand {
  static command = 'devtools:clear';
  static description = 'Remove every entry the devtools recorded';

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const store = await storeOf(this.#app);
    const { bytes, files } = await store.usage();
    await store.clear();
    output.success(`Removed the devtools' entries (${files} ${files === 1 ? 'file' : 'files'}, ${megabytes(bytes)}).`);
    return 0;
  }
}

/** `marmeon devtools:prune`: removes entries past the ring's age, then the oldest until it is within its size. */
export class DevtoolsPruneCommand {
  static command = 'devtools:prune';
  static description = "Remove the devtools' entries past their age or size limit";

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const store = await storeOf(this.#app);
    const { files, bytes } = await store.prune();
    const usage = await store.usage();
    output.success(`Pruned ${files} ${files === 1 ? 'file' : 'files'} (${megabytes(bytes)}); ${usage.files} left (${megabytes(usage.bytes)}).`);
    return 0;
  }
}
