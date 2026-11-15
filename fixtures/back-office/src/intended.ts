import type { Session } from '@marmeon/session';

/**
 * Whether the page a guest wanted before signing in lies below the back office (`path`, or a page under it). The session keeps one such page for
 * all guards, so a page of the app stored by a customer must not take an editor there; the editor's sign-in leaves it in place.
 */
export function intendedBelow(session: Session, path: string): boolean {
  // `_intended_url` is the http package's internal key for the page `redirect().intended()` follows. The framework keeps one such page for all
  // guards; if the key were renamed, this would answer false and the sign-in would go to the overview.
  const url = session.get('_intended_url');
  return typeof url === 'string' && (url === path || url.startsWith(`${path}/`) || url.startsWith(`${path}?`));
}
