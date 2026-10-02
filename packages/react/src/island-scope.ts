import { createContext, useContext } from 'react';

/**
 * @internal The island a component renders in — its region's id (`'ssr'` while rendering on the server), or undefined
 * outside one. Remembered state of an island is kept apart from its page's (E63). A module of its own: remembering needs it,
 * islands' code does not come with it.
 */
export const IslandScopeContext = createContext<string | undefined>(undefined);

/** @internal See {@link IslandScopeContext}. */
export function useIslandScope(): string | undefined {
  return useContext(IslandScopeContext);
}
