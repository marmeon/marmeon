import { describe, expect, it } from 'vitest';
import * as server from './index.ts';
import * as internal from './internal.ts';

describe('the entry points of the server', () => {
  it('keeps what an app documents in the main entry', () => {
    for (const name of ['createHttpKernel', 'startServer', 'ServerConfig', 'ServerServiceProvider', 'ViteSetupError']) expect(server, name).toHaveProperty(name);
  });

  it('keeps the dev server and the error page recorder out of the main entry and in ./internal', () => {
    for (const name of ['DevRequestRecorder', 'DevDocument', 'createViteDevRenderer', 'importVite', 'importRequestRecorder', 'refuseUndecidedRoutes', 'heldOnLoopback']) {
      expect(server, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('drops the rendering internals from every entry', () => {
    for (const name of ['createResponseFactory', 'createDocumentRenderer', 'createProductionRenderer', 'shellRenderer', 'renderDocument', 'HEAD_OUTLET', 'ServerTiming']) {
      expect(server, name).not.toHaveProperty(name);
      expect(internal, name).not.toHaveProperty(name);
    }
  });
});
