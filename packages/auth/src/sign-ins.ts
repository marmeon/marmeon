import { randomBytes } from 'node:crypto';
import { Clock, token } from '@marmeon/core';
import { Connections, type Generated } from '@marmeon/database';

/** The table the app's migration creates (`marmeon make:sign-ins-table` writes it) — see {@link SignInsTable}. */
export const SIGN_INS_TABLE = 'sign_ins';

/**
 * The columns {@link DatabaseSignIns} needs. A row is one sign-in of one browser and the authority over it: the session
 * carries only the row's id, and a session whose row is gone ends. No IP address is stored.
 */
export interface SignInsTable {
  id: string;
  user_id: number | string;
  user_agent: string | null;
  remember_selector: string | null;
  remember_until: string | Date | null;
  signed_in_at: string | Date;
  last_seen_at: string | Date;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** A sign-in as listed to its user. */
export interface SignInRecord {
  readonly id: string;
  readonly userId: number | string;
  /** The browser's `User-Agent`, cut to 255 characters; feed it to `describeDevice()`. */
  readonly userAgent: string | undefined;
  /** Whether a remember-me cookie keeps this browser signed in. */
  readonly remembered: boolean;
  readonly signedInAt: Date;
  /** Written at most every {@link SEEN_GRANULARITY_SECONDS} seconds. */
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
}

/** How long a session may idle and how long it may last at all (`SESSION_LIFETIME`, `AUTH_SESSION_MAX_HOURS`), in seconds — what makes a row alive. */
export interface SignInWindow {
  readonly idleSeconds: number;
  readonly maxSeconds: number;
}

/**
 * The sign-ins of the app's users, one row per browser. Opt-in: bind `SignInStore` to `DatabaseSignIns` and create the
 * table with `marmeon make:sign-ins-table`. Every method that takes an id first checks its shape and asks nothing for a
 * malformed one; every query names the user.
 */
export interface SignInStore {
  /** A new sign-in; returns its id (128 random bits, base64url). */
  create(input: { userId: number | string; userAgent: string | undefined; remember?: { selector: string; until: Date } }): Promise<string>;
  /** Continues the sign-in that owns this remember-me selector (the same browser is one row): its id, or `undefined` when there is no such row — never creates one. */
  resume(userId: number | string, selector: string, until: Date): Promise<string | undefined>;
  /** Sets or removes the remember-me selector of a sign-in. */
  remember(userId: number | string, id: string, remember: { selector: string; until: Date } | undefined): Promise<void>;
  /** Whether the sign-in still exists; with `touch`, also writes `last_seen_at` when it is older than {@link SEEN_GRANULARITY_SECONDS}. Never creates one. */
  seen(userId: number | string, id: string, touch: boolean): Promise<boolean>;
  /** The user's living sign-ins, the most recently seen first. */
  list(userId: number | string, window: SignInWindow): Promise<readonly SignInRecord[]>;
  /** Deletes one sign-in of the user; `false` when there is none (another user's id is none). */
  end(userId: number | string, id: string): Promise<boolean>;
  /** Deletes every sign-in of the user, except `except`; how many. */
  endAll(userId: number | string, except?: string): Promise<number>;
  /** Deletes exactly the rows `list` does not show, of every user; how many. */
  prune(window: SignInWindow): Promise<number>;
}
export const SignInStore = token<SignInStore>('SignInStore');

/** `last_seen_at` is written at most this often — no write per request, and a coarse time is all a list needs. */
export const SEEN_GRANULARITY_SECONDS = 300;

const ID = /^[A-Za-z0-9_-]{22}$/;
const USER_AGENT_LENGTH = 255;

/** The default {@link SignInStore}, on the app's `sign_ins` table. */
export class DatabaseSignIns implements SignInStore {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async create(input: { userId: number | string; userAgent: string | undefined; remember?: { selector: string; until: Date } }): Promise<string> {
    const id = randomBytes(16).toString('base64url');
    const now = this.#now();
    await this.#db()
      .insertInto(SIGN_INS_TABLE)
      .values({
        id,
        user_id: input.userId,
        user_agent: cleanUserAgent(input.userAgent),
        remember_selector: input.remember?.selector ?? null,
        remember_until: input.remember?.until ?? null,
        signed_in_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async resume(userId: number | string, selector: string, until: Date): Promise<string | undefined> {
    const now = this.#now();
    const row = await this.#db()
      .updateTable(SIGN_INS_TABLE)
      .set({ signed_in_at: now, last_seen_at: now, remember_until: until, updated_at: now })
      .where('remember_selector', '=', selector)
      .where('user_id', '=', userId)
      .returning('id')
      .executeTakeFirst();
    return row?.id;
  }

  async remember(userId: number | string, id: string, remember: { selector: string; until: Date } | undefined): Promise<void> {
    if (!ID.test(id)) return;
    await this.#db()
      .updateTable(SIGN_INS_TABLE)
      .set({ remember_selector: remember?.selector ?? null, remember_until: remember?.until ?? null, updated_at: this.#now() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }

  async seen(userId: number | string, id: string, touch: boolean): Promise<boolean> {
    if (!ID.test(id)) return false;
    const db = this.#db();
    const row = await db.selectFrom(SIGN_INS_TABLE).select('last_seen_at').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) return false;
    if (touch) {
      const now = this.#now();
      // `!(a > b)`: an unreadable time counts as old and is rewritten.
      if (!(new Date(row.last_seen_at).getTime() > now.getTime() - SEEN_GRANULARITY_SECONDS * 1000)) {
        await db.updateTable(SIGN_INS_TABLE).set({ last_seen_at: now, updated_at: now }).where('id', '=', id).where('user_id', '=', userId).execute();
      }
    }
    return true;
  }

  async list(userId: number | string, window: SignInWindow): Promise<readonly SignInRecord[]> {
    const now = this.#clock.now();
    const rows = await this.#db()
      .selectFrom(SIGN_INS_TABLE)
      .select(['id', 'user_id', 'user_agent', 'remember_selector', 'remember_until', 'signed_in_at', 'last_seen_at', 'created_at'])
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([
          eb('remember_until', '>', new Date(now)),
          eb.and([eb('last_seen_at', '>', lastSeenLimit(now, window)), eb('signed_in_at', '>', signedInLimit(now, window))]),
        ]),
      )
      .orderBy('last_seen_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userAgent: row.user_agent ?? undefined,
      remembered: row.remember_until !== null && new Date(row.remember_until).getTime() > now,
      signedInAt: new Date(row.signed_in_at),
      lastSeenAt: new Date(row.last_seen_at),
      createdAt: new Date(row.created_at),
    }));
  }

  async end(userId: number | string, id: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    const result = await this.#db().deleteFrom(SIGN_INS_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async endAll(userId: number | string, except?: string): Promise<number> {
    let query = this.#db().deleteFrom(SIGN_INS_TABLE).where('user_id', '=', userId);
    if (except !== undefined && ID.test(except)) query = query.where('id', '!=', except);
    return Number((await query.executeTakeFirst()).numDeletedRows);
  }

  async prune(window: SignInWindow): Promise<number> {
    const now = this.#clock.now();
    const result = await this.#db()
      .deleteFrom(SIGN_INS_TABLE)
      // Written positively, not as `not(alive)`: a null `remember_until` would make that null, and the row would stay.
      .where((eb) =>
        eb.and([
          eb.or([eb('remember_until', 'is', null), eb('remember_until', '<=', new Date(now))]),
          eb.or([eb('last_seen_at', '<=', lastSeenLimit(now, window)), eb('signed_in_at', '<=', signedInLimit(now, window))]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #db() {
    return this.#connections.get<{ [SIGN_INS_TABLE]: SignInsTable }>();
  }
}

// A row lives while its remember-me cookie does, or while it is within the idle limit (plus the write granularity) and the absolute one.
const lastSeenLimit = (now: number, window: SignInWindow) => new Date(now - (window.idleSeconds + SEEN_GRANULARITY_SECONDS) * 1000);
const signedInLimit = (now: number, window: SignInWindow) => new Date(now - window.maxSeconds * 1000);

/** Cleaned and cut to 255 characters; nothing left → `null`. */
function cleanUserAgent(userAgent: string | undefined): string | null {
  // Control and format characters (bidi overrides included) out; a cut must not leave half of a surrogate pair.
  const clean = (userAgent ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, USER_AGENT_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
  return clean === '' ? null : clean;
}
