import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { createApplication, defineModule } from '@marmeon/core';
import { HttpServiceProvider } from '@marmeon/http';
import { defineRoutes, everyone, RouteAccessError, type RouteBinder, type RouteDefinitions } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

describe('createHttpKernel — routes that do not say who may call them', () => {
  class Note {}
  class NoteRepository implements RouteBinder<Note> {
    resolveRouteBinding() {
      return new Note();
    }
  }
  class ShowNoteController {
    handle() {
      return 'note';
    }
  }

  const boot = (routes: RouteDefinitions | undefined, env: Record<string, string> = {}) =>
    createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { APP_KEY: generateKey(), ...env },
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: routes ? [defineModule({ name: 'notes', routes })] : [],
    });

  it('refuses to start, and names the route, its controller, its name and the file that registered it', async () => {
    const application = await boot(defineRoutes((Route) => Route.get('/about', ShowNoteController).name('about')));
    try {
      expect(() => createHttpKernel(application)).toThrow(/GET {2}\/about {2}about {2}ShowNoteController {2}.*kernel-access\.test\.ts:\d+/);
      expect(() => createHttpKernel(application)).toThrow('docs/authorization.md#authorizing-requests');
    } finally {
      await application.shutdown();
    }
  });

  it('refuses a route that lets everyone call it and binds a record by its key', async () => {
    const application = await boot(defineRoutes((Route) => Route.authorize(everyone).bind('note', NoteRepository).get('/notes/:note', ShowNoteController)));
    try {
      expect(() => createHttpKernel(application)).toThrow(/binds `note` with NoteRepository/);
    } finally {
      await application.shutdown();
    }
  });

  it('refuses in production as well', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const application = await boot(defineRoutes((Route) => Route.get('/about', ShowNoteController)), { NODE_ENV: 'production' });
    try {
      expect(() => createHttpKernel(application)).toThrow(RouteAccessError);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      await application.shutdown();
    }
  });

  it('shows a path without the secret in it', async () => {
    const secret = 'k3JdP9xQw2LmZ8vTn5RbY7uHc1AeF4sG';
    const application = await boot(defineRoutes((Route) => Route.get(`/hooks/${secret}/:token`, ShowNoteController)));
    try {
      expect(() => createHttpKernel(application)).toThrow(/\/hooks\//);
      let message = '';
      try {
        createHttpKernel(application);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(secret);
    } finally {
      await application.shutdown();
    }
  });

  it('starts with routes that decided, and with only the framework’s own routes', async () => {
    const decided = await boot(defineRoutes((Route) => Route.authorize(everyone).get('/about', ShowNoteController)));
    const frameworkOnly = await boot(undefined);
    try {
      expect((await createHttpKernel(decided).request('/about')).status).toBe(200);
      expect(() => createHttpKernel(frameworkOnly)).not.toThrow();
    } finally {
      await decided.shutdown();
      await frameworkOnly.shutdown();
    }
  });
});
