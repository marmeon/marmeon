import { Application, Clock, CommandArgumentsError } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { NotificationStore } from './store.ts';

/** The migration `make:notifications-table` copies — a real file, so the tests run exactly what apps get. */
export const NOTIFICATIONS_MIGRATION = new URL('../stubs/migrations/0001_01_01_000000_create_notifications_table.ts', import.meta.url);

/** `marmeon make:notifications-table [--module=system]`: the migration of `notifications` into an app module. */
export class MakeNotificationsTableCommand {
  static command = 'make:notifications-table';
  static description = 'Create the migration for the database notification channel (notifications)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { NotificationServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('./index.ts')]);
    return publishOwnMigrations(input, new URL('../', import.meta.url), NotificationServiceProvider, this.#app.providers);
  }
}

const DAY = 86_400_000;

/**
 * `marmeon notifications:prune [--days=30] [--unread-days=N]`: deletes notifications read more than `--days` ago — and,
 * with `--unread-days`, unread ones older than that (kept by default: unread is unread). One statement, the time from
 * the app's `Clock`. For the scheduler: `s.command('notifications:prune').daily().at('03:30').onOneServer()`.
 */
export class PruneNotificationsCommand {
  static command = 'notifications:prune';
  static description = 'Delete old read notifications (and, with --unread-days, old unread ones)';
  static usage = '[--days=30] [--unread-days=N]';
  static options = { days: { type: 'string' }, 'unread-days': { type: 'string' } } as const;

  readonly #store: NotificationStore;
  readonly #clock: Clock;

  constructor(store: NotificationStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const days = options.days === undefined ? 30 : Number(options.days);
    const unreadDays = options['unread-days'] === undefined ? undefined : Number(options['unread-days']);
    if (!Number.isFinite(days) || days < 0) {
      throw new CommandArgumentsError(`--days must be a number ≥ 0 (notifications read longer ago than that are deleted), not ${String(options.days)}.`);
    }
    if (unreadDays !== undefined && (!Number.isFinite(unreadDays) || unreadDays < 0)) {
      throw new CommandArgumentsError(`--unread-days must be a number ≥ 0 (unread notifications older than that are deleted), not ${String(options['unread-days'])}.`);
    }
    const now = this.#clock.now();
    const deleted = await this.#store.prune({ readBefore: new Date(now - days * DAY), unreadBefore: unreadDays === undefined ? undefined : new Date(now - unreadDays * DAY) });
    output.success(`Pruned ${deleted} ${deleted === 1 ? 'notification' : 'notifications'}.`);
    return 0;
  }
}
