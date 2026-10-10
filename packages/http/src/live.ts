/**
 * Live props, the server's side of a response: what a page, an island or a layer declares to follow
 * (`.live(channel, { only })`) and what every page shares (`shared.live(…)`). The response factory signs each channel for the
 * request's session (`LiveSigner`, bound by @marmeon/live) into `PageObject.live` — the answer that may show the page is
 * the one that says who may hear its hints (no second policy).
 */
import { token } from '@marmeon/core';
import type { JoinNames } from '@marmeon/router';
import type { LiveSubscription, SharedProps } from './page.ts';

/** What a channel's name may hold: letters, digits, `_`, `-`, `.` and `:` — `users.7`, `dashboard.sign-ins`, `team:4.tasks`. */
export const LIVE_CHANNEL = /^[\w.:-]{1,200}$/;

/** Whether `channel` is a channel's name ({@link LIVE_CHANNEL}). */
export function isLiveChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && LIVE_CHANNEL.test(channel);
}

/** `only` of a subscription, or undefined — checked: names of props, nothing else. */
function checkedOnly(only: unknown, where: string): readonly string[] | undefined {
  if (only === undefined) return undefined;
  if (!Array.isArray(only) || !only.every((name) => typeof name === 'string' && name !== '')) {
    throw new TypeError(`${where}: only is a list of prop names, got ${JSON.stringify(only)}.`);
  }
  return [...(only as string[])];
}

/** `channel` when it is a channel's name — else a clear error. */
export function checkedChannel(channel: unknown, where: string): string {
  if (!isLiveChannel(channel)) {
    throw new TypeError(`${where}: a live channel is a name of letters, digits, "_", "-", "." and ":" (at most 200) — got ${JSON.stringify(channel)}.`);
  }
  return channel;
}

/** A channel a response follows, as it was declared — its name (or how to find it for the request) and the props it reloads. */
export interface LiveDeclaration {
  /** The channel — or a function of the request (a shared one: the signed-in user's) that says which, or none. */
  readonly channel: string | (() => string | undefined | Promise<string | undefined>);
  readonly only?: readonly string[] | undefined;
}

/** Declarations a result carries — beside it, never one of its fields (a result is data: spread, compared in tests). */
const declared = new WeakMap<object, LiveDeclaration[]>();

/** Adds a live subscription to `result` (a page, an island, a layer). */
export function addLive<R extends object>(result: R, channel: unknown, options: { only?: unknown } = {}): R {
  const where = `.live(${JSON.stringify(channel)})`;
  const only = checkedOnly(options.only, where);
  declared.set(result, [...(declared.get(result) ?? []), { channel: checkedChannel(channel, where), ...(only ? { only } : {}) }]);
  return result;
}

/** The live subscriptions `result` declares. */
export function liveOf(result: object): readonly LiveDeclaration[] {
  return declared.get(result) ?? [];
}

/** `to` (made from `from`: a layer from its view) declares what `from` did. */
export function carryLive(from: object, to: object): void {
  const subscriptions = declared.get(from);
  if (subscriptions) declared.set(to, [...subscriptions]);
}

/** Defines `.live()` on a plain result object — not enumerable: a result is data. */
export function withLiveMethod<R extends object>(result: R): R {
  Object.defineProperty(result, 'live', { enumerable: false, value: (channel: unknown, options?: { only?: unknown }) => addLive(result, channel, options) });
  return result;
}

/**
 * The props of `only`, each checked against `Names` — a name that is not one becomes the message the compiler shows as the
 * expected type: `'avtar' is not a prop of this page — its props: activity, profile, …`.
 */
export type LiveOnly<O extends readonly string[], Names extends string, What extends string = 'this page'> = {
  readonly [I in keyof O]: O[I] extends Names ? O[I] : `'${O[I] & string}' is not a prop of ${What} — its props: ${JoinNames<Names>}`;
};

/**
 * The `.live(channel, { only })` of a result whose props are `Names`: it follows `channel` — the browser reloads `only` (of
 * the props the hint names, `broadcast.refresh(channel, { only })`; all of them when it names none) when the server hints a
 * change, over one stream per tab. Default `only`: whatever the hint names, or everything.
 */
export type LiveMethod<R, Names extends string, What extends string = 'this page'> = <const O extends readonly string[] = readonly []>(
  channel: string,
  options?: { readonly only?: LiveOnly<O, Names, What> },
) => R;

/** The names of a page's props: its own and the shared ones (the bell in its layout). */
export type PagePropNames<TProps> = (keyof TProps & string) | (keyof SharedProps & string);

/**
 * Signs a channel for the request's session — bound per request by @marmeon/live: an HMAC over the channel and a hash
 * of the session's id, keyed from `APP_KEY`. The stream (`/_marmeon/live`) accepts a channel only with it, for that session.
 */
export interface LiveSigner {
  /**
   * The channel's token — undefined in a read-only request (an island) whose guest has no session to bind it to: it
   * cannot start one, so the subscription is left out and the answer goes out without it (never a 500).
   */
  sign(channel: string): string | undefined;
}
export const LiveSigner = token<LiveSigner>('LiveSigner');

/**
 * The subscriptions of a response, signed — `PageObject.live`: what the result declares and (`shared`, for a page) what every
 * page shares. A shared channel's function that answers none (a guest) declares nothing. Undefined: none.
 */
export async function signedLive(
  declarations: readonly LiveDeclaration[],
  signer: () => LiveSigner,
): Promise<LiveSubscription[] | undefined> {
  if (declarations.length === 0) return undefined;
  const subscriptions: LiveSubscription[] = [];
  const tokens = new Map<string, string>();
  for (const declaration of declarations) {
    const channel = typeof declaration.channel === 'function' ? await declaration.channel() : declaration.channel;
    if (channel === undefined || channel === null) continue;
    const name = checkedChannel(channel, 'A shared live channel');
    let token = tokens.get(name);
    if (token === undefined) {
      token = signer().sign(name);
      // No session to bind it to in a read-only request (a guest's island): no subscription, the answer itself still goes out.
      if (token === undefined) continue;
      tokens.set(name, token);
    }
    subscriptions.push({ channel: name, ...(declaration.only ? { only: declaration.only } : {}), token });
  }
  return subscriptions.length > 0 ? subscriptions : undefined;
}
