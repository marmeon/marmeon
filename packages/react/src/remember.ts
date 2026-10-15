import { remember, type LooksLikePassword, type LooksSensitive, type Remembered } from '@marmeon/http/client';
import { useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { RegionOwnerContext, useRouterContext } from './app.tsx';
import { useIslandScope } from './island-scope.ts';

type IsPassword<K extends string> = LooksLikePassword<K>;

/** The key of remembered state: anything — but a name that looks sensitive needs `{ sensitive: true }` (and a password never). */
export type RememberKey<K extends string> =
  IsPassword<K> extends true
    ? `'${K}' looks like a password — passwords are never remembered: they stay in the field until the page is left`
    : LooksSensitive<K> extends true
      ? `'${K}' looks sensitive (a token, a secret, a code, a card) — remembered state leaves it out unless you say so: useRemember('${K}', initial, { sensitive: true })`
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
  // The feature attaches on first use: an app that remembers nothing carries none of it.
  return { store: entry ? navigator?.use(remember).of(entry) : undefined, key: island === undefined ? key : `island:${island}:${key}` };
}

/**
 * State that survives Back/Forward — `useState`, remembered with the history entry (the page's, the layer's it is rendered
 * in, or an island's own). In memory only: never in `history.state` or any storage.
 *
 * ```tsx
 * const [tab, setTab] = useRemember('links-tab', 'links');
 * ```
 *
 * Never sensitive data: fields named like a password, token, secret, credential, one-time or recovery code or card and files are left out at any depth — a key
 * named so is a compile error unless `{ sensitive: true }` (never for passwords). See docs/navigation.md#remembered-state.
 */
export function useRemember<T, const K extends string = string>(key: RememberKey<K>, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>];
export function useRemember<T, const K extends string = string>(key: SensitiveKey<K>, initial: T | (() => T), options: UseRememberOptions): [T, Dispatch<SetStateAction<T>>];
export function useRemember<T>(key: string, initial: T | (() => T), { sensitive }: UseRememberOptions = {}): [T, Dispatch<SetStateAction<T>>] {
  const { store, key: scoped } = useRememberStore(key);
  // What the store holds was let in when it was written: reading needs no rules.
  const [value, setValue] = useState<T>(() => {
    if (store?.has(scoped)) return store.get(scoped) as T;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const first = useRef(true);
  useEffect(() => {
    // Kept with the entry on screen — written again when the entry changes (a sort link pushed a new one with this component).
    if (!store) return;
    if (first.current && !store.has(scoped)) {
      first.current = false;
      // The initial value is what a fresh entry shows anyway: nothing to keep yet.
      return;
    }
    first.current = false;
    // A key named like a password is never kept; a sensitive-looking one only when asked for. The rules load with the first write.
    const include = sensitive ? [key] : [];
    store.set(scoped, value, include, key);
  }, [store, scoped, value, key, sensitive]);
  return [value, setValue];
}
