import type { Output } from 'marmeon';
import type { Connection, SeedContext, SeedOutput } from './index.ts';
import type { Tables } from './types.ts';

declare const factory: SeedContext['factory'];
declare const db: Connection<Tables>;

// A context a test builds by hand has no `output`.
export const byHand: SeedContext = { factory, db };
new (class {
  handle(context: SeedContext) {
    context.output?.info('x');
    // @ts-expect-error — `output` is optional: `?.` is needed
    context.output.info('x');
  }
})().handle({ factory, db });

// The console's `Output` is a `SeedOutput` without an adapter.
declare const consoleOutput: Output;
export const fromConsole: SeedOutput = consoleOutput;
