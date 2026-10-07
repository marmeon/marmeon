/**
 * Optimistic UI, model 1 (E59): a typed patch on the props of a page, a layer or a region, shown at once while an action is
 * under way — rolled back when it fails, reconciled with the server's props when it succeeded. UI-free.
 *
 * What is shown is always `the server's props + the patches under way`, computed again whenever either changes: a patch is a
 * function of the props beneath it, so two actions on the same list compose, and taking one out (its action failed) leaves
 * the other's in place — no snapshot of one action can undo another's. The props beneath stay the server's: memory keeps
 * only them (the page cache never holds a patch, nor does `history.state` — it holds no props at all, E36), so Back/Forward
 * after a rollback shows nothing of it.
 */
import type { DevtoolsGlobal } from './features/devtools.ts';
import { rethrowLater } from './notify.ts';

/**
 * A patch of props: the props it changes, from the props shown beneath it (the server's with the patches before it). It
 * runs again whenever those change — pure, no side effects.
 */
export type PropsPatch = (props: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;

/**
 * A reload of some props (`only`), all but some (`except`), or — neither — all of them. It is a revalidation (an action's, Back's):
 * what it brings replaces what was there, also where the server marked a prop `merge()`/`deepMerge()` — a row deleted meanwhile
 * is gone, nothing is appended. `reset` names the merged props it replaces instead (`[]`: it merges them, as before Wave 9).
 */
export interface ReloadSpec {
  readonly only?: readonly string[];
  readonly except?: readonly string[];
  /** The merged props it replaces — default: every prop it brings. */
  readonly reset?: readonly string[];
}


/**
 * Where patches go — the page of a history entry, a layer, a region (an island). The navigator, layers and regions implement
 * it; adapters only pass it on (`OptimisticUpdate`, `Reloading`).
 */
export interface PatchTarget {
  /** Shows `patch` on top of what is shown, at once. Returns its id. */
  add(patch: PropsPatch): number;
  /**
   * Takes these patches out. `commit`: folded into the props beneath first — their action succeeded and nothing reloads them,
   * so what they show is the state now. Otherwise they are gone: rolled back. `quiet`: nothing is rendered for it — what
   * comes next (a form's answer) is.
   */
  settle(ids: readonly number[], commit: boolean, options?: { readonly quiet?: boolean }): void;
  /**
   * Reloads props from the server (in the background: no progress bar, no failure dialog) — and takes `ids`, the patches of an
   * action that succeeded, out in the same update the server's props land in, so nothing flickers back. A reload that does
   * not land (offline, another page by now) leaves their state as it is: they are committed. Reloads of one target started
   * by actions replace each other (the newest asks for what all of them asked for), so an older answer never lands last.
   */
  revalidate(spec: ReloadSpec, ids: readonly number[]): Promise<void>;
}

/** A patch for a target — what `router.optimistic(…)` gives an action (or a form's visit). */
export interface OptimisticUpdate {
  readonly target: PatchTarget;
  readonly patch: PropsPatch;
}

/** A reload of a target after an action succeeded — what `router.reloading({ only })` gives an action. */
export interface Reloading {
  readonly target: PatchTarget;
  readonly spec: ReloadSpec;
}

/** Ids of patches, unique within the tab. */
let nextPatch = 0;

interface Props {
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * The patches under way on one target, in the order they were made. `apply` shows them over the server's props — the same
 * object again while neither changed (adapters compare by identity).
 */
export class PatchQueue {
  #patches: { readonly id: number; readonly patch: PropsPatch }[] = [];
  #memo: { base: object; view: object } | undefined;

  get size(): number {
    return this.#patches.length;
  }

  has(id: number): boolean {
    return this.#patches.some((entry) => entry.id === id);
  }

  add(patch: PropsPatch): number {
    const id = ++nextPatch;
    this.#patches.push({ id, patch });
    this.#memo = undefined;
    return id;
  }

  /** Takes these out; whether any was here. */
  remove(ids: Iterable<number>): boolean {
    const gone = new Set(ids);
    // Development only (W7 step 9): the devtools' bar marks them settled — gone from a production build.
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__?.removed?.(gone);
    const before = this.#patches.length;
    this.#patches = this.#patches.filter((entry) => !gone.has(entry.id));
    if (this.#patches.length === before) return false;
    this.#memo = undefined;
    return true;
  }

  clear(): void {
    this.#patches = [];
    this.#memo = undefined;
  }

  /** `base` with every patch over it — `base` itself without any. */
  apply<T extends Props>(base: T): T {
    if (this.#patches.length === 0) return base;
    if (this.#memo?.base === base) return this.#memo.view as T;
    const view = run(base, this.#patches);
    this.#memo = { base, view };
    return view;
  }

  /** `base` with only these patches over it (in their order) — what committing them makes the state. */
  fold<T extends Props>(base: T, ids: Iterable<number>): T {
    const chosen = new Set(ids);
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__?.committed?.(chosen);
    return run(base, this.#patches.filter((entry) => chosen.has(entry.id)));
  }
}

function run<T extends Props>(base: T, patches: readonly { readonly id: number; readonly patch: PropsPatch }[]): T {
  let props = base.props;
  for (const { patch } of patches) {
    try {
      // Development only (W7 step 9): what each patch changed, for the devtools' bar — a production build calls the patch alone.
      props = { ...props, ...(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? observed(patches, patch, props) : patch(props)) };
    } catch (error) {
      // A patch's bug shows nothing of it — and breaks neither the page nor the other patches.
      rethrowLater(error);
    }
  }
  return props === base.props ? base : { ...base, props };
}

/** Development only: `patch` over `props` — reported to the devtools' dev hook (W7 step 9). */
function observed(patches: readonly { readonly id: number; readonly patch: PropsPatch }[], patch: PropsPatch, props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const changed = patch(props);
  const id = patches.find((entry) => entry.patch === patch)?.id;
  if (id !== undefined) (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__?.patched?.(id, props, changed);
  return changed;
}


/** Two reloads as one: `only` lists united, else everything — and what either replaces, replaced. */
export function unite(a: ReloadSpec | undefined, b: ReloadSpec): ReloadSpec {
  if (!a) return b;
  const both = (x?: readonly string[], y?: readonly string[]) => (x && y ? [...new Set([...x, ...y])] : undefined);
  const only = a.except?.length || b.except?.length ? undefined : both(a.only, b.only);
  const reset = both(a.reset, b.reset);
  return { ...(only ? { only } : {}), ...(reset ? { reset } : {}) };
}

/**
 * The reloads of one target that actions start (`PatchTarget.revalidate`): one at a time — a newer one aborts the one under
 * way and asks for what both asked for, and takes its patches over. So a slower, older answer never lands after a newer one.
 */
export class Revalidations {
  #controller: AbortController | undefined;
  #spec: ReloadSpec | undefined;
  #waiting: { readonly ids: readonly number[]; readonly done: () => void }[] = [];

  /**
   * Starts a reload: `load` asks the server and lands what it got, taking the patches (`ids`) out in the same update — it
   * resolves with whether it landed. When it did not, `commit` makes their state the state (their action succeeded).
   */
  run(
    spec: ReloadSpec,
    ids: readonly number[],
    load: (spec: ReloadSpec, ids: ReadonlySet<number>, signal: AbortSignal) => Promise<boolean>,
    commit: (ids: readonly number[]) => void,
  ): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const united = unite(this.#spec, spec);
    this.#spec = united;
    const done = new Promise<void>((resolve) => this.#waiting.push({ ids, done: resolve }));
    const all = new Set(this.#waiting.flatMap((entry) => entry.ids));
    void (async () => {
      let landed = false;
      try {
        landed = await load(united, all, controller.signal);
      } catch {
        landed = false;
      }
      // Replaced by a newer reload: that one settles these patches too.
      if (this.#controller !== controller) return;
      this.#controller = undefined;
      this.#spec = undefined;
      const waiting = this.#waiting.splice(0);
      if (!landed && !controller.signal.aborted) commit([...all]);
      for (const entry of waiting) entry.done();
    })();
    return done;
  }

  /** Stops the reload under way (the document is left): nothing lands, every action waiting for it goes on. */
  abort(): void {
    this.#controller?.abort();
  }
}
