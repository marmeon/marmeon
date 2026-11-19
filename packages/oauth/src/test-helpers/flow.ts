import type { Container, Logger, ServiceProviderClass } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { Session, SessionConfig } from '@marmeon/session';
import type { OAuthConfig } from '../config.ts';
import type { OAuthProviderDefinition } from '../definition.ts';
import { OAuth } from '../oauth.ts';
import { isBuiltByOidc, recordBuilt } from '../oidc-marker.ts';
import { OAuthProviders, type ResolvedOAuthProvider } from '../registry.ts';
import { definition } from './app.ts';

/** Just what the flow uses of a session; `data` is what it holds, `started` and `readOnly` can be switched. */
export function fakeSession(state: { started?: boolean; readOnly?: boolean } = {}): Session & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    started: state.started ?? true,
    readOnly: state.readOnly ?? false,
    put: (key: string, value: unknown) => void data.set(key, value),
    pull: (key: string) => {
      const value = data.get(key);
      data.delete(key);
      return value;
    },
  } as unknown as Session & { data: Map<string, unknown> };
}

/** A logger that keeps what it is told, as one text per entry. */
export function recordingLogger(): Logger & { readonly entries: string[] } {
  const entries: string[] = [];
  const log = (level: string) => (message: string, context?: Readonly<Record<string, unknown>>) => void entries.push(`${level} ${message} ${JSON.stringify(context ?? {})}`);
  const logger: Logger & { readonly entries: string[] } = {
    entries,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  };
  return logger;
}

export type FakeSession = Session & { data: Map<string, unknown> };

export interface Parts<S extends Session = FakeSession> {
  readonly overrides?: Partial<OAuthProviderDefinition>;
  /** The definition `oidc()` built that `overrides` is a spread of: a spread copies the markers but not the membership, so the provider made here is recorded as built by `oidc()` when this was. */
  readonly builtFrom?: object;
  readonly redirectUrl?: string;
  readonly scopes?: readonly string[];
  readonly appUrl?: string | undefined;
  readonly sameSite?: string;
  readonly local?: boolean;
  readonly logger?: Logger;
  readonly session?: S;
  readonly name?: string;
  /** The session package is not there: its session and settings are `undefined`, as the provider answers for an unbound service. The client throws. */
  readonly unbound?: boolean;
}

/** An `OAuth` over one active provider `idp`, built by hand — the registry's checks are not in the way — with a fake session and client. */
export function oauthWith<S extends Session = FakeSession>(parts: Parts<S> = {}) {
  const name = parts.name ?? 'idp';
  const provider: ResolvedOAuthProvider = {
    name,
    label: 'Example',
    definition: definition(parts.overrides),
    credentials: { clientId: 'client', clientSecret: 'secret', redirectUrl: parts.redirectUrl, scopes: parts.scopes, issuer: undefined, options: {} },
  };
  if (parts.builtFrom !== undefined && isBuiltByOidc(parts.builtFrom)) recordBuilt(provider.definition);
  const session = (parts.session ?? fakeSession()) as S;
  const http = new HttpClientFake();
  const clock = new TestClock();
  clock.freeze(1_700_000_000_000);
  const appUrl = 'appUrl' in parts ? parts.appUrl : 'https://app.example.com';
  const missing = (): undefined => undefined;
  const oauth = new OAuth(
    new OAuthProviders([provider]),
    parts.unbound ? missing : () => session,
    parts.unbound ? missing : () => ({ sameSite: parts.sameSite ?? 'lax' }) as SessionConfig,
    parts.unbound
      ? () => {
          throw new Error('No binding.');
        }
      : () => http,
    { appUrl } as OAuthConfig,
    clock,
    parts.logger ?? recordingLogger(),
    parts.local ?? false,
  );
  return { oauth, session, http, clock };
}

/** A provider class that reads the session's settings and hands each request scope the next of `sessions`, standing in for the session package's binding. */
export function sessionsFrom(sessions: readonly Session[]): ServiceProviderClass {
  const queue = [...sessions];
  return {
    FakeSessionProvider: class {
      static config = [SessionConfig];
      register(container: Container): void {
        container.scoped(Session, () => queue.shift()!);
      }
    },
  }.FakeSessionProvider;
}
