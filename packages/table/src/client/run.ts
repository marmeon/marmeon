/**
 * A table's row or bulk action as an action request (E59), then the table's prop reloaded — loaded with a table's first run (W9 step
 * 6): the actions feature and the page's reloads are a chunk of their own, so a page that only shows a table carries neither.
 */
import { actions, optimistic, type ActionOutcome, type Confirm, type Navigator } from '@bespokecore/http/client';

export interface TableRun {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly confirm: Confirm | undefined;
  readonly signal: AbortSignal | undefined;
  /** The page prop to reload — undefined: the whole page. */
  readonly only: readonly string[] | undefined;
}

export function runTableAction(navigator: Navigator, { url, body, confirm, signal, only }: TableRun): Promise<ActionOutcome> {
  return navigator.use(actions).run(url, {
    data: body,
    ...(confirm !== undefined ? { confirm } : {}),
    ...(signal ? { signal } : {}),
    // A revalidation (W9 step 3): what the server says now replaces what the page had — a row gone stays gone, merged or not.
    reload: { target: navigator.use(optimistic).page, spec: only ? { only } : {} },
  });
}
