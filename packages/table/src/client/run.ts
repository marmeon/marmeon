/**
 * A table's row or bulk action as an action request, then the table's prop reloaded. A chunk of its own, loaded with a table's
 * first run: a page that only shows a table carries neither the actions feature nor the page's reloads.
 */
import { actions, optimistic, type ActionOutcome, type Confirm, type Navigator } from '@marmeon/http/client';

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
    // A revalidation: what the server says now replaces what the page had — a row gone stays gone, merged or not.
    reload: { target: navigator.use(optimistic).page, spec: only ? { only } : {} },
  });
}
