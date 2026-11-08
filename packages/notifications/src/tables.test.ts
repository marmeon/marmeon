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
  const env = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test' };
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
  it("the notifications table of the web app, the blank app and the starter comes from the stub", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /notifications_table/.test(file));
    for (const [dir, file] of [
      ['apps/web-app/modules/system/migrations/', '2026_10_03_094821_create_notifications_table.ts'],
      ['apps/blank-app/modules/system/migrations/', '2026_11_08_124605_create_notifications_table.ts'],
      ['packages/create-marmeon/template/base/modules/system/migrations/', '2026_11_08_124605_create_notifications_table.ts'],
    ] as const) {
      expect(filesOf(dir), dir).toEqual([file]);
      expect(readFileSync(new URL(dir + file, repo), 'utf8'), dir).toBe(readFileSync(NOTIFICATIONS_MIGRATION, 'utf8'));
    }
  });
});
