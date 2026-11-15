import type { Session } from '@marmeon/session';

/**
 * Whether the page a guest wanted before signing in lies below the back office (`path`, or a page under it). The session keeps one such page for
 * all guards, so a page of the app stored by a customer must not take an editor there; the editor's sign-in leaves it in place.
 */
export function intendedBelow(session: Session, path: string): boolean {
  // `_intended_url` is the http package's internal key for the page `redirect().intended()` follows. The framework keeps one such page for all
  // guards; if the key were renamed, this would answer false and the sign-in would go to the overview.
  const url = session.get('_intended_url');
  if (typeof url !== 'string') return false;
  // The router matches the decoded path, so `/%6Fffice/sessions` is a page of the back office: the path is decoded as `decodeURI` does (`%2F` stays
  // encoded, so it is no separator), and one that cannot be decoded is no page below. The stored URL itself is what the redirect follows.
  const end = url.search(/[?#]/);
  let pathname: string;
  try {
    pathname = decodeURI(end === -1 ? url : url.slice(0, end));
  } catch {
    return false;
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}
