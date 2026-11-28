// Type guarantees of defineSearch — checked by `tsc` (pnpm build / typecheck), never run.
import { describe, it } from 'vitest';
import { defineSearch, type SearchDefinition } from './config.ts';

describe('defineSearch', () => {
  it('takes a map of locales to configuration names, and nothing else', () => {
    const fine: SearchDefinition = defineSearch({ languages: { 'de-CH': 'german' } });
    void fine;
    void defineSearch();
    // @ts-expect-error — a configuration is named by a string.
    defineSearch({ languages: { de: 1 } });
    // @ts-expect-error — the one option is languages.
    defineSearch({ langauges: { ga: 'irish' } });
  });

  it('is told apart from other configuration by a brand only defineSearch gives', () => {
    // @ts-expect-error — an object with the shape of a config definition is no SearchDefinition.
    const fake: SearchDefinition = { key: Symbol('x'), name: 'search', env: {} as never, resolve: () => ({ languages: new Map() }) };
    void fake;
  });
});
