import { isSensitiveRememberField, remember, type Remembered } from '@marmeon/http/client';
import { useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { RegionOwnerContext, useRouterContext } from './app.tsx';
import { useIslandScope } from './island-scope.ts';

/** Names that look like something never to keep (E63): a password, a token, a secret, a card. */
type LooksSensitive<K extends string> = Lowercase<K> extends `${string}${'password' | 'secret' | 'token' | 'card' | 'cvc'}${string}` ? true : false;

type IsPassword<K extends string> = Lowercase<K> extends `${string}password${string}` ? true : false;

/** The key of remembered state: anything — but a name that looks sensitive needs `{ sensitive: true }` (and a password never). */
export type RememberKey<K extends string> =
  IsPassword<K> extends true
    ? `'${K}' looks like a password — passwords are never remembered (E63): they stay in the field until the page is left`
    : LooksSensitive<K> extends true
      ? `'${K}' looks sensitive (a token, a secret, a card) — remembered state leaves it out unless you say so: useRemember('${K}', initial, { sensitive: true })`
      : K;

/** A sensitive-looking key the app keeps on purpose — never a password. */
type SensitiveKey<K extends string> = IsPassword<K> extends true ? RememberKey<K> : K;

export interface UseRememberOptions {
  /** Keep it although its key looks sensitive (`token`, `secret`, `card`, …) — never for a password. */
  sensitive?: true;
}

/** @internal Where remembered state of the component lives: its history entry's (the page's or its layer's), or none (server). */
export function useRememberStore(key: string): { store: Remembered | undefined; key: string } {
  const navigator = useRouterContext().navigator();
  const entry = useContext(RegionOwnerContext)?.entry;
  const island = useIslandScope();
  // The feature attaches on first use (E70): an app that remembers nothing carries none of it.
  return { store: entry ? navigator?.use(remember).of(entry) : undefined, key: island === undefined ? key : `island:${island}:${key}` };
}

/**
 * State that survives Back/Forward (E63) — `useState`, remembered with the history entry: leave the page, come back, and it
 * is as it was (an open tab, a filter, a draft). In memory only (E36): never in `history.state` or any storage — a reload,
 * signing in or out, a new build or a language switch start over, and so does an entry the cache let go of. Per history
 * entry: the page's, or the layer's it is rendered in; an island's are its own.
 *
 * ```tsx
 * const [tab, setTab] = useRemember('links-tab', 'links');
 * ```
 *
 * Never sensitive data: fields named like a password, token, secret or card (`/password|secret|token|card|cvc/i`) and files are
 * left out of what is kept, at any depth — a key named so is a compile error unless `{ sensitive: true }` (never for passwords).
 * No tab sync (E66): another tab keeps its remembered state after signing out here, until it navigates or reloads.
 */
export function useRemember<T, const K extends string = string>(key: RememberKey<K>, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>];
export function useRemember<T, const K extends string = string>(key: SensitiveKey<K>, initial: T | (() => T), options: UseRememberOptions): [T, Dispatch<SetStateAction<T>>];
export function useRemember<T>(key: string, initial: T | (() => T), { sensitive }: UseRememberOptions = {}): [T, Dispatch<SetStateAction<T>>] {
  const { store, key: scoped } = useRememberStore(key);
  // A key named like a password is never kept; a sensitive-looking one only when asked for.
  const keep = !isSensitiveRememberField(key, sensitive ? [key] : []);
  const [value, setValue] = useState<T>(() => {
    if (keep && store?.has(scoped)) return store.get(scoped) as T;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const first = useRef(true);
  useEffect(() => {
    // Kept with the entry on screen — written again when the entry changes (a sort link pushed a new one with this component).
    if (!keep || !store) return;
    if (first.current && !store.has(scoped)) {
      first.current = false;
      // The initial value is what a fresh entry shows anyway: nothing to keep yet.
      return;
    }
    first.current = false;
    store.set(scoped, value, sensitive ? [key] : []);
  }, [store, scoped, value, keep, key, sensitive]);
  return [value, setValue];
}
