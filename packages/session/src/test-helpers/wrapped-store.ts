import { SessionStore } from '../store.ts';

type Operations = Pick<SessionStore, 'read' | 'write' | 'destroy' | 'gc'>;

/** A store that hands every operation to `inner` — except the ones `overrides` replaces — so a test can watch or disturb a store. */
export function wrapped(inner: SessionStore, overrides: Partial<Operations>): SessionStore {
  class Wrapped extends SessionStore {
    read = overrides.read ?? ((key: string) => inner.read(key));
    write = overrides.write ?? ((key: string, data: string, options: Parameters<SessionStore['write']>[2]) => inner.write(key, data, options));
    destroy = overrides.destroy ?? ((key: string) => inner.destroy(key));
    gc = overrides.gc ?? ((lifetime: number) => inner.gc(lifetime));
  }
  return new Wrapped();
}
