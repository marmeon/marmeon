import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, Logger, type ModuleDefinition } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { Members, silent, Welcome } from './__fixtures__/app.ts';
import { NOTIFICATIONS_MIGRATION } from './commands.ts';
import { NotificationServiceProvider } from './index.ts';

/** A notification that only sends mail: nothing of it reaches the table. */
class MailOnly {
  static readonly notification = 'shop.mail-only';
  static readonly schema = v.object({});

  via() {
    return ['mail'] as const;
  }

  toMail() {
    return {} as never;
  }
}

describe('the notifications table', () => {
  const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test' };
  const open = (modules: ModuleDefinition[]) =>
    createApplication({ root: '/tmp', discover: false, providers: [DatabaseServiceProvider, NotificationServiceProvider], modules }, { env, override: (container) => container.instance(Logger, silent) });
  const shop = [{ name: 'shop', notifications: [Welcome], recipients: { member: Members } }];

  it('is a table readiness waits for when a notification has `static database` — one that only sends mail needs none', async () => {
    const required = async (modules: ModuleDefinition[]) => {
      await using application = await open(modules);
      return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
    };
    expect(await required(shop)).toEqual(['notifications']);
    expect(await required([])).toEqual([]);
    expect(await required([{ name: 'shop', notifications: [MailOnly as never], recipients: { member: Members } }])).toEqual([]);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the notifications comes from the stub, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /notifications_table/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_03_094821_create_notifications_table.ts']);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(NOTIFICATIONS_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
