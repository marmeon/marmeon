import { Connections, type SeedContext } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DemoUsersSeeder } from '../auth/seeders/DemoUsersSeeder.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';
import { DemoLinksSeeder } from './seeders/DemoLinksSeeder.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const context = (lines: string[]): SeedContext => ({
  factory: (definition) => app.factory(definition),
  db: app.make(Connections).get(),
  output: { line: () => {}, info: (text: string) => void lines.push(text), warn: () => {}, table: () => {} },
});

describe('DemoLinksSeeder', { timeout: 30_000 }, () => {
  it('reports how many links it made through output', async () => {
    const lines: string[] = [];
    await app.make(DemoUsersSeeder).handle(context([]));
    await app.make(DemoLinksSeeder).handle(context(lines));
    expect(lines).toEqual(['Made 2 profile links for ada@example.com.']);
  });

  it('runs without an output, as a test that builds the context by hand does', async () => {
    await app.make(DemoUsersSeeder).handle(context([]));
    const handBuilt: SeedContext = { factory: (definition) => app.factory(definition), db: app.make(Connections).get() };
    await expect(app.make(DemoLinksSeeder).handle(handBuilt)).resolves.toBeUndefined();
  });
});
