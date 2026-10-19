import type { Application, Logger } from '@marmeon/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandInput } from '../command.ts';
import type { DevProcesses } from '../dev.ts';
import type { RouteTypes } from '../route-types.ts';
import { noPrompt } from '../prompt.ts';
import { ServeCommand } from './serve.ts';

const migrations = vi.hoisted(() => ({ close: vi.fn(), watch: vi.fn() }));
const server = vi.hoisted(() => ({ close: vi.fn(async () => {}), lastError: { close: vi.fn(), idle: vi.fn() }, startLastError: vi.fn(), startServer: vi.fn() }));

vi.mock('@marmeon/server', () => ({
  ServerConfig: class {},
  ViteSetupError: class extends Error {},
  startServer: server.startServer,
}));
vi.mock('@marmeon/server/internal', () => ({
  refuseUndecidedRoutes: () => {},
  heldOnLoopback: async () => undefined,
  shadowedLocalhost: async () => undefined,
  startLastError: server.startLastError,
}));
vi.mock('./route-types.ts', () => ({ writeRouteTypes: async () => true, RouteTypesCommand: class {} }));
vi.mock('../migration-watch.ts', () => ({ watchMigrations: migrations.watch }));
vi.mock('../unlisted.ts', () => ({ warnUnlisted: () => 0 }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Runs `marmeon serve` for an app that is stubbed, and stops it with SIGINT once the server listens. */
async function serve(nodeEnv: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  server.startServer.mockImplementation(async () => ({ close: server.close }));
  server.startLastError.mockImplementation(async () => server.lastError);
  migrations.watch.mockImplementation(async () => ({ close: migrations.close }));
  const app = { container: { has: () => false }, modules: [] } as unknown as Application;
  const logger = { info: () => {} } as unknown as Logger;
  const devProcesses = { all: () => [] } as unknown as DevProcesses;
  const command = new ServeCommand(app, logger, {} as RouteTypes, devProcesses);
  const output = { error: () => {}, warn: () => {}, info: () => {} } as unknown as CommandInput['output'];
  const running = command.handle({ args: [], options: {}, output, root: '/nowhere', spawn: async () => 0, prompt: noPrompt });
  await vi.waitFor(() => expect(server.startServer).toHaveBeenCalled());
  await vi.waitFor(() => expect(process.listenerCount('SIGINT')).toBeGreaterThan(0));
  process.emit('SIGINT');
  expect(await running).toBe(0);
}

describe('marmeon serve and the last-error file', () => {
  it('starts the writer where the development server starts, and stops it with the server', async () => {
    await serve('development');
    expect(server.startLastError).toHaveBeenCalledTimes(1);
    expect(server.lastError.close).toHaveBeenCalledTimes(1);
  });

  it('does not start it for a production server', async () => {
    await serve('production');
    expect(server.startServer).toHaveBeenCalledTimes(1);
    expect(server.startLastError).not.toHaveBeenCalled();
  });
});

describe('marmeon serve and the migration watcher', () => {
  it('watches the migrations where the development server runs, and stops with the server', async () => {
    await serve('development');
    expect(migrations.watch).toHaveBeenCalledTimes(1);
    expect(migrations.close).toHaveBeenCalledTimes(1);
  });

  it('does not watch them for a production server', async () => {
    await serve('production');
    expect(migrations.watch).not.toHaveBeenCalled();
  });
});
