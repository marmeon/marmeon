import { Application, Container } from '@marmeon/core';
import type { Connection } from './builder.ts';
import { Connections } from './connections.ts';
import { Factories, type FactoryDefinition, type PendingFactory } from './factories.ts';
import type { Tables } from './types.ts';

/** What a seeder's `handle` gets. */
export interface SeedContext {
  /** Rows from a factory: `await factory(UserFactory).count(10).create()`. */
  factory<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S>;
  readonly db: Connection<Tables>;
}

/**
 * A seeder: a class with `handle`, built by the container (constructor injection, like controllers,
 * commands and listeners). Listed by its module: `defineModule({ seeders: [DemoUsersSeeder] })`.
 */
export interface Seeder {
  handle(context: SeedContext): void | Promise<void>;
}
export type SeederClass = new (...args: any[]) => Seeder;

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** Seeders of the module, run in this order by `marmeon db:seed`. */
    readonly seeders?: readonly SeederClass[];
  }
}

/** Runs the modules' seeders, in module order. */
export class Seeding {
  readonly #app: Application;
  readonly #container: Container;
  readonly #connections: Connections;
  readonly #factories: Factories;

  constructor(app: Application, container: Container, connections: Connections, factories: Factories) {
    this.#app = app;
    this.#container = container;
    this.#connections = connections;
    this.#factories = factories;
  }

  /** Every seeder, in module order — optionally only one module's, or one class by name. */
  seeders(filter: { module?: string; seeder?: string } = {}): { module: string; seeder: SeederClass }[] {
    if (filter.module && !this.#app.modules.some((m) => m.name === filter.module)) throw new Error(`There is no module "${filter.module}".`);
    const all = this.#app.modules
      .filter((module) => !filter.module || module.name === filter.module)
      .flatMap((module) => (module.seeders ?? []).map((seeder) => ({ module: module.name, seeder })));
    const selected = filter.seeder ? all.filter(({ seeder }) => seeder.name === filter.seeder) : all;
    if (filter.seeder && selected.length === 0) throw new Error(`There is no seeder "${filter.seeder}"${filter.module ? ` in module "${filter.module}"` : ''}.`);
    return selected;
  }

  async run(filter: { module?: string; seeder?: string } = {}, onRun?: (run: { module: string; seeder: string; ms: number }) => void): Promise<void> {
    const context: SeedContext = {
      factory: (definition) => this.#factories.for(definition),
      db: this.#connections.get(),
    };
    for (const { module, seeder } of this.seeders(filter)) {
      const started = performance.now();
      await this.#container.make(seeder).handle(context);
      onRun?.({ module, seeder: seeder.name, ms: performance.now() - started });
    }
  }
}
