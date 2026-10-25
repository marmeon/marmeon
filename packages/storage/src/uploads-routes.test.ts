import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider } from '@marmeon/http';
import { defineRoutes, everyone } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { rules as r, type Rule } from '@marmeon/validation';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage } from './config.ts';
import { StorageServiceProvider, upload } from './index.ts';
import { uploadFields } from './uploads/rule.ts';

afterAll(removeDirectories);

const file = () => upload({ maxBytes: 1000 });

function controllerOf(schema: Parameters<typeof defineRequest>[0]['schema']) {
  return class extends Controller {
    static request = defineRequest({ schema });
    handle() {
      return 'ok';
    }
  };
}

/** An app with one form route whose body schema is `schema`; the start is what is tested. */
function boot(schema: Parameters<typeof defineRequest>[0]['schema']) {
  const base = freshDirectory();
  const Form = controllerOf(schema);
  return createApplication({
    root: base,
    discover: false,
    config: [defineStorage({ default: 'uploads', disks: { uploads: { driver: 'local', root: join(base, 'uploads') } } })],
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
    modules: [defineModule({ name: 'forms', routes: defineRoutes((Route) => Route.authorize(everyone).post('/form', Form).name('form.store')) })],
  }, {
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', UPLOADS_CONNECTION: 'default' },
  });
}

describe('upload fields are read when the routes load', () => {
  it.each([
    ['a list of files', () => r.object({ photos: r.array(file()) }), '`photos` holds a list of files'],
    ['a file in an optional object', () => r.object({ profile: r.object({ photo: file() }).optional() }), '`profile.photo` holds a file in an optional or nullable rule'],
    ['a file in a nullable object', () => r.object({ profile: r.object({ photo: file() }).nullable() }), '`profile.photo` holds a file in an optional or nullable rule'],
    ['a file in a union', () => r.object({ photo: r.union([file(), r.literal('none')]) }), '`photo` holds a file in a union'],
  ])('%s stops the start, not the first submit', async (_name, schema, message) => {
    await expect(boot(schema())).rejects.toThrow(message);
  });

  it('a schema built by a factory boots, and its submit answers 500 — not a 422 that says nothing', async () => {
    const app = await boot(() => r.object({ photos: r.array(file()) }));
    const answer = await createHttpKernel(app).request('/form', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    expect(answer.status).toBe(500);
  });

  it('an upload nested deeper than 10 fields stops the start, whatever wraps it', async () => {
    let schema: Rule<any, any> = file();
    for (let level = 0; level < 12; level++) schema = r.object({ level: schema }).optional();
    await expect(boot(r.object({ deep: schema }))).rejects.toThrow('nested deeper than 10 fields');
    expect(() => uploadFields(r.object({ deep: file() }))).not.toThrow();
  });

  it('a body nested past 10 fields boots when no upload is in it', async () => {
    let plain: Rule<any, any> = r.string();
    let optional: Rule<any, any> = r.string().optional();
    for (let level = 0; level < 12; level++) {
      plain = r.object({ level: plain });
      optional = r.object({ level: optional });
    }
    await expect(boot(plain)).resolves.toBeDefined();
    await expect(boot(optional)).resolves.toBeDefined();
  });

  it('a shape that holds itself ends the search', () => {
    const shape: Record<string, Rule<any, any>> = {};
    const loop = r.object(shape);
    shape.again = r.array(r.union([loop, r.string()])).optional();
    shape.deep = loop;
    expect(() => uploadFields(loop)).not.toThrow(); // bounded by the depth of fields
    let nested: Rule<any, any> = loop;
    for (let level = 0; level < 12; level++) nested = r.object({ level: nested });
    expect(() => uploadFields(nested)).not.toThrow();
  });

  it('a start with the supported shapes works', async () => {
    const app = await boot(r.object({ cv: file().nullable(), profile: r.object({ photo: file() }), name: r.string() }));
    expect(app).toBeDefined();
  });
});
