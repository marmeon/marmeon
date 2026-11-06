import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import { defineRoutes, everyone, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { RouteTypes } from './route-types.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('RouteTypes.write — the file is a link', () => {
  const router = new Router().load({ group: 'web' }, defineRoutes((Route) => Route.authorize(everyone).get('/', () => 'home').name('home')));
  const typesIn = (root: string) => new RouteTypes({ root, definition: {} } as unknown as Application, router);

  it('rewrites a regular file', async () => {
    const root = realpathSync(tempDir('marmeon-route-types-'));
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(join(root, 'bootstrap/routes.ts'), 'old');
    expect((await typesIn(root).write()).changed).toBe(true);
    expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'home'");
  });

  it('refuses bootstrap/routes.ts as a link out of the project and leaves the file it points at', async () => {
    const root = realpathSync(tempDir('marmeon-route-types-'));
    const outside = realpathSync(tempDir('marmeon-route-types-outside-'));
    writeFileSync(join(outside, 'kept.ts'), 'untouched');
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'kept.ts'), join(root, 'bootstrap/routes.ts'));
    await expect(typesIn(root).write()).rejects.toThrow(/bootstrap\/routes\.ts leads out of the project.*Nothing was written/);
    expect(readFileSync(join(outside, 'kept.ts'), 'utf8')).toBe('untouched');
  });

  it('refuses a link out of the project to a file with the same content instead of calling it up to date', async () => {
    const root = realpathSync(tempDir('marmeon-route-types-'));
    const outside = realpathSync(tempDir('marmeon-route-types-outside-'));
    const types = typesIn(root);
    writeFileSync(join(outside, 'same.ts'), (await types.render()).source);
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'same.ts'), join(root, 'bootstrap/routes.ts'));
    await expect(types.write()).rejects.toThrow(/leads out of the project/);
  });

  it('refuses a bootstrap folder that is a link out of the project', async () => {
    const root = realpathSync(tempDir('marmeon-route-types-'));
    const outside = realpathSync(tempDir('marmeon-route-types-outside-'));
    symlinkSync(outside, join(root, 'bootstrap'));
    await expect(typesIn(root).write()).rejects.toThrow(/leads out of the project/);
    expect(existsSync(join(outside, 'routes.ts'))).toBe(false);
  });

  it('isCurrent refuses a link out of the project instead of reading it', async () => {
    const root = realpathSync(tempDir('marmeon-route-types-'));
    const outside = realpathSync(tempDir('marmeon-route-types-outside-'));
    const types = typesIn(root);
    writeFileSync(join(outside, 'same.ts'), (await types.render()).source);
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'same.ts'), join(root, 'bootstrap/routes.ts'));
    await expect(types.isCurrent()).rejects.toThrow(/leads out of the project/);
  });
});
