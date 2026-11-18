import { createHash, randomBytes } from 'node:crypto';
import { err, ok, type Result } from '@marmeon/core';
import type { Session } from '@marmeon/session';

/** How long the person has at the provider, in seconds. */
export const FLOW_SECONDS = 600;

/** What an open flow is bound to: the provider, the intent, optionally one user, and the values the callback must hand back. */
export interface OpenFlow {
  readonly provider: string;
  readonly state: string;
  /** Without PKCE there is none. */
  readonly verifier?: string;
  readonly nonce?: string;
  readonly intent: string;
  readonly userId?: string | number;
  /** The id the provider must vouch for: set for a confirmation only. */
  readonly account?: string;
  /** Seconds since the epoch. */
  readonly issuedAt: number;
  /** Seconds since the epoch. */
  readonly until: number;
}

export type FlowError = { readonly kind: 'no-flow' } | { readonly kind: 'expired' } | { readonly kind: 'invalid' };

/** The session key of the flow of `provider`: one slot per provider, so a flow of one never serves another. */
export const flowKey = (provider: string): string => `_oauth_flow:${provider}`;

const random = (): string => randomBytes(32).toString('base64url');

/** The PKCE challenge of `verifier` (method `S256`). */
export const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/**
 * Opens a flow in the session of the browser that starts it. A provider has one slot, so a new flow replaces the old one. The
 * state, the verifier and the nonce are 256 random bits each; they never leave the session except in the request to the provider.
 */
export function issueFlow(
  session: Session,
  input: { readonly provider: string; readonly intent: string; readonly userId?: string | number; readonly account?: string; readonly pkce: boolean; readonly nonce: boolean; readonly nowSeconds: number },
): OpenFlow {
  const flow: OpenFlow = {
    provider: input.provider,
    state: random(),
    ...(input.pkce ? { verifier: random() } : {}),
    ...(input.nonce ? { nonce: random() } : {}),
    intent: input.intent,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    ...(input.account === undefined ? {} : { account: input.account }),
    issuedAt: input.nowSeconds,
    until: input.nowSeconds + FLOW_SECONDS,
  };
  session.put(flowKey(input.provider), flow);
  return flow;
}

/**
 * Takes the open flow of `provider` out of the session — before anything is checked, so it works once even when the check fails.
 * What came out of the store is checked: a value of another shape is `invalid`, one that is past its time `expired`, and one that
 * names another provider `invalid`.
 */
export function takeFlow(session: Session, provider: string, nowSeconds: number): Result<OpenFlow, FlowError> {
  // A request that may not write the session cannot spend the flow (a `forget()` is dropped there), so it would serve twice: none is taken.
  if (!session.started || session.readOnly) return err({ kind: 'no-flow' });
  // The key is a name, not a `SessionData` field: what comes out of the store is untrusted until checked here.
  const open = session.pull(flowKey(provider)) as unknown;
  if (open === undefined || open === null) return err({ kind: 'no-flow' });
  if (typeof open !== 'object') return err({ kind: 'invalid' });
  const flow = open as Partial<Record<keyof OpenFlow, unknown>>;
  if (typeof flow.state !== 'string' || flow.state === '' || typeof flow.intent !== 'string') return err({ kind: 'invalid' });
  if (!Number.isSafeInteger(flow.until) || !Number.isSafeInteger(flow.issuedAt)) return err({ kind: 'invalid' });
  const { issuedAt, until } = flow as { issuedAt: number; until: number };
  // The record is untrusted, so its two times say nothing about each other alone: the span is the one this package gives, and the end
  // is not further away than that (a minute more for a node whose clock runs a little off).
  if (until - issuedAt !== FLOW_SECONDS || until - nowSeconds > FLOW_SECONDS + 60) return err({ kind: 'invalid' });
  // Written so that a `nowSeconds` that is no number never serves a flow.
  if (!(nowSeconds < until)) return err({ kind: 'expired' });
  if (flow.provider !== provider) return err({ kind: 'invalid' });
  if (flow.verifier !== undefined && (typeof flow.verifier !== 'string' || flow.verifier === '')) return err({ kind: 'invalid' });
  if (flow.nonce !== undefined && (typeof flow.nonce !== 'string' || flow.nonce === '')) return err({ kind: 'invalid' });
  if (flow.userId !== undefined && typeof flow.userId !== 'string' && typeof flow.userId !== 'number') return err({ kind: 'invalid' });
  if (flow.account !== undefined && (typeof flow.account !== 'string' || flow.account === '')) return err({ kind: 'invalid' });
  return ok({
    provider,
    state: flow.state,
    ...(flow.verifier === undefined ? {} : { verifier: flow.verifier as string }),
    ...(flow.nonce === undefined ? {} : { nonce: flow.nonce as string }),
    intent: flow.intent,
    ...(flow.userId === undefined ? {} : { userId: flow.userId }),
    ...(flow.account === undefined ? {} : { account: flow.account as string }),
    issuedAt,
    until,
  });
}
