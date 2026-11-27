import { defineMigration } from '../../../index.ts';
import { PAUSE, type Pause } from '../state-pause/2026_01_31_000000_create_paused_table.ts';

// The first step waits to be let go: what the marker shows meanwhile is what a second process sees.
export default defineMigration({
  up: (schema) => {
    schema.data(async () => {
      const pause = (globalThis as Record<symbol, Pause | undefined>)[PAUSE];
      pause?.entered();
      await pause?.released;
    });
    schema.create('pausing', (table) => table.id());
  },
  down: (schema) => schema.drop('pausing'),
});
