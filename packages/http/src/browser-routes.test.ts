import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineRoutes, Router } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { BROWSER_ROUTES_FILE, browserRoutes, writeBrowserRoutes } from './browser-routes.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const web = defineRoutes((Route) => {
  Route.get('/users/:user', () => 'profile').name('users.show');
  Route.get('/email/verify/:id/:hash', () => 'verified').name('verification.verify').internal();
  Route.get('/admin/secret', () => 'secret').name('admin.secret');
  Route.internal()
    .prefix('/ops')
    .name('ops.')
    .group((Route) => {
      Route.get('/health', () => 'ok').name('health');
      Route.post('/flush', () => 'flushed').name('flush');
    });
  Route.get('/unnamed', () => 'no name');
});

const api = defineRoutes((Route) => {
  Route.get('/users', () => []).name('api.users.index');
});

const router = new Router().load({ group: 'web' }, web).load({ group: 'api', prefix: '/api' }, api);

describe('browserRoutes', () => {
  it('lets the browser learn the named web routes — never .internal() ones, alone or by group', () => {
    expect(router.routes.filter((route) => route.isInternal).map((route) => route.routeName)).toEqual(['verification.verify', 'ops.health', 'ops.flush']);
    expect(browserRoutes(router.routes)).toEqual({
      version: 1,
      routes: { 'admin.secret': { method: 'get', path: '/admin/secret' }, 'users.show': { method: 'get', path: '/users/:user' } },
      hidden: { 'api.users.index': 'api', 'ops.flush': 'internal', 'ops.health': 'internal', 'verification.verify': 'internal' },
    });
  });

  it('keeps .internal() routes out even when clientRoutes.include matches everything; except wins over include', () => {
    const everything = browserRoutes(router.routes, { include: ['*'] });
    expect(Object.keys(everything.routes)).toEqual(['admin.secret', 'api.users.index', 'users.show']);
    expect(everything.hidden).toEqual({ 'ops.flush': 'internal', 'ops.health': 'internal', 'verification.verify': 'internal' });

    const without = browserRoutes(router.routes, { include: ['api.*'], except: ['admin.*', 'api.users.index'] });
    expect(Object.keys(without.routes)).toEqual(['users.show']);
    expect(without.hidden['admin.secret']).toBe('except');
    expect(without.hidden['api.users.index']).toBe('except');
  });

  it('is written to .bespoke/routes.json only when it changed', () => {
    const root = tempDir('bespoke-browser-routes-');
    const routes = browserRoutes(router.routes);
    expect(writeBrowserRoutes(root, routes)).toBe(true);
    expect(writeBrowserRoutes(root, routes)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, BROWSER_ROUTES_FILE), 'utf8'))).toEqual(routes);
    expect(writeBrowserRoutes(root, browserRoutes(router.routes, { include: ['*'] }))).toBe(true);
  });
});
