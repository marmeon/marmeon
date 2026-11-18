// Type guarantees of `SocialAccounts` and `SocialUserProvider` — checked by `tsc` (typecheck), never run.
import type { AuthUser } from '@marmeon/auth';
import type { Result } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import type { SocialUser } from '../definition.ts';
import { SocialAccountLinked, SocialAccountUnlinked } from './events.ts';
import type { SocialAccountSummary, SocialLinkError, SocialSignIn, SocialSignInError, SocialUnlinkError } from './social-accounts.ts';
import { SocialAccounts } from './social-accounts.ts';
import { SocialUserProvider } from './users.ts';

declare const accounts: SocialAccounts;
declare const social: SocialUser;

// Every answer an app must handle is a Result, with a kind to switch on.
expectTypeOf(accounts.signIn(social)).toEqualTypeOf<Promise<Result<SocialSignIn, SocialSignInError>>>();
expectTypeOf(accounts.link(social)).toEqualTypeOf<Promise<Result<SocialAccountSummary, SocialLinkError>>>();
expectTypeOf(accounts.unlink('github')).toEqualTypeOf<Promise<Result<void, SocialUnlinkError>>>();
expectTypeOf(accounts.list()).toEqualTypeOf<Promise<readonly SocialAccountSummary[]>>();

expectTypeOf<SocialSignInError['kind']>().toEqualTypeOf<'signed-in' | 'account-exists' | 'registration-closed' | 'email-required' | 'email-unverified' | 'invalid-account'>();
expectTypeOf<SocialLinkError['kind']>().toEqualTypeOf<'signed-out' | 'confirmation-required' | 'email-unconfirmed' | 'invalid-account' | 'taken' | 'provider-linked'>();
expectTypeOf<SocialUnlinkError['kind']>().toEqualTypeOf<'signed-out' | 'confirmation-required' | 'not-found' | 'last-method'>();
expectTypeOf<SocialSignIn['kind']>().toEqualTypeOf<'signed-in' | 'two-factor-required'>();

// An account-exists answer says whether the provider verified the address, so the page can say what to do.
declare const refused: Extract<SocialSignInError, { kind: 'account-exists' }>;
expectTypeOf(refused.providerVerified).toEqualTypeOf<boolean>();

// The events carry the user and the provider.
expectTypeOf<SocialAccountLinked['user']>().toEqualTypeOf<AuthUser>();
expectTypeOf<SocialAccountLinked['email']>().toEqualTypeOf<string | null>();
expectTypeOf<SocialAccountUnlinked['provider']>().toEqualTypeOf<string>();

// The app's SocialUserProvider makes a user or reports a duplicate, nothing else.
expectTypeOf<SocialUserProvider['create']>().returns.resolves.toEqualTypeOf<Result<AuthUser, { readonly kind: 'duplicate' }>>();
expectTypeOf<SocialUserProvider['findByEmail']>().returns.resolves.toEqualTypeOf<{ readonly user: AuthUser; readonly emailVerified: boolean } | undefined | null>();
// create() is given a profile that has an address.
expectTypeOf<Parameters<SocialUserProvider['create']>[0]['email']>().toEqualTypeOf<string>();
// @ts-expect-error a provider needs create() and emailConfirmed()
const incomplete: SocialUserProvider = { findByEmail: async () => undefined };
void incomplete;
// @ts-expect-error a provider that finds and creates users still needs emailConfirmed(): link() refuses a user it cannot vouch for
const noConfirmation: SocialUserProvider = { findByEmail: async () => undefined, create: async () => ({ ok: false, error: { kind: 'duplicate' } }) };
void noConfirmation;
expectTypeOf<SocialUserProvider['emailConfirmed']>().returns.toEqualTypeOf<boolean | Promise<boolean>>();
expectTypeOf<'canConfirm'>().not.toExtend<keyof SocialAccountSummary>();
