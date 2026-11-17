import { Clock, type Container } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { AuthUserId } from './user.ts';

/**
 * What a verified re-authentication hands to the app guard to open its confirmation window. Only a {@link Reauthenticator} makes one;
 * the object is opaque: what it stands for is kept where nobody can reach it, so changing the object changes nothing.
 *
 * @internal
 */
export interface ReauthenticationProof {
  /** The name the issuer claimed. */
  readonly via: string;
}

/**
 * The capability to issue proofs, held by whoever claimed a name. Whoever holds it vouches that the user just authenticated again
 * by a means the framework cannot see (a provider, say): hand it to no code that has not verified that itself. See
 * `docs/oauth.md#confirming-with-a-provider`.
 *
 * @internal
 */
export interface Reauthenticator {
  issue(input: { readonly userId: AuthUserId | string | number; readonly authenticatedAt: Date }): ReauthenticationProof;
}

/**
 * Where the app guard takes a proof (`auth[CONFIRM_REAUTHENTICATED](proof)`), answering whether it opened the confirmation window. App
 * code cannot name the symbol: it is exported from the internal entry only.
 *
 * @internal
 */
export const CONFIRM_REAUTHENTICATED = Symbol('marmeon.auth.confirmReauthenticated');

/** How long a proof can wait between being issued and being taken, in milliseconds. */
export const PROOF_MAX_AGE_MS = 60_000;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** What a proof stands for. Invariant: the guard reads this, never the object it was handed. */
interface ProofRecord {
  readonly userId: string;
  /** When the user authenticated, in milliseconds. */
  readonly at: number;
  /** When the proof was issued, in milliseconds of the root container's `Clock`. */
  readonly issuedAt: number;
  readonly via: string;
  /** The root container the capability was claimed on: a proof opens a window only for the guard of that container. */
  readonly root: object;
}

/**
 * Every proof issued and not yet taken, with what it stands for. Invariant: a proof counts only if it is a key here, and taking it
 * removes it, so a proof made any other way (an object with the same fields, a copy) or taken before is refused. Not exported.
 */
const proofs = new WeakMap<object, ProofRecord>();

/** The names claimed on a root container, and whether the auth provider has booted (no claim after that). */
const claims = new WeakMap<object, { readonly names: Set<string>; sealed: boolean }>();

const claimsOf = (root: object) => {
  let found = claims.get(root);
  if (found === undefined) {
    found = { names: new Set(), sealed: false };
    claims.set(root, found);
  }
  return found;
};

/**
 * Ends the claims on `root`: a name claimed afterwards (by code that runs once the app is up) throws, as a guard registered late does.
 *
 * @internal
 */
export function sealReauthentication(root: object): void {
  claimsOf(root).sealed = true;
}

/**
 * Takes a proof: what it stands for, if the framework issued it and nobody took it before, for a capability claimed on `root`.
 * Whatever the answer, the proof is spent afterwards.
 *
 * @internal
 */
export function takeProof(proof: object, root: object | undefined): ProofRecord | undefined {
  const record = proofs.get(proof);
  proofs.delete(proof);
  // A root whose claims were never ended is one the auth provider has not booted: no guard of it takes a proof yet.
  if (record === undefined || record.root !== root || claims.get(root)?.sealed !== true) return undefined;
  return record;
}

/**
 * Claims `name` once per root container, before the auth provider boots, and returns the capability to issue proofs for it. A second
 * claim of the same name, a claim on a request's scope, a claim after the boot and a name of another form throw (code A12): a second
 * claim of the same name throws, so whoever holds a name's capability is the only one who issues under that name.
 *
 * @internal
 */
export function reauthenticator(container: Container, name: string): Reauthenticator {
  if (!NAME.test(name)) throw new Error(withCode('A12', `A re-authentication name is lower case letters, digits and hyphens, starting with a letter, at most 32 long: got ${JSON.stringify(name)}.`));
  if (container.isScope) throw new Error(withCode('A12', `The re-authentication "${name}" is claimed on a request's scope: claim it on the app's container, in a provider's register().`));
  const claimed = claimsOf(container);
  if (claimed.sealed) throw new Error(withCode('A12', `The re-authentication "${name}" is claimed after the auth provider booted: claim it in a provider's register().`));
  if (claimed.names.has(name)) throw new Error(withCode('A12', `The re-authentication "${name}" is claimed already: its capability is handed out once per container.`));
  claimed.names.add(name);
  return {
    issue({ userId, authenticatedAt }) {
      const proof: ReauthenticationProof = Object.freeze({ via: name });
      proofs.set(proof, { userId: String(userId), at: authenticatedAt.getTime(), issuedAt: container.make(Clock).now(), via: name, root: container });
      return proof;
    },
  };
}
