import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Settings of the status board area. */
export const StatusBoardConfig = defineConfig('statusBoard', {
  env: env({
    /** Where the area lives: its pages are below this path. */
    STATUS_BOARD_PATH: env.string().regex(/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected one path segment like /status').default('/status'),
  }),
  resolve: (e) => ({ path: e.STATUS_BOARD_PATH }),
});
export type StatusBoardConfig = ConfigOf<typeof StatusBoardConfig>;
