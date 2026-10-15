/**
 * A path (and query) derived from a request, as a `Location` that stays on this site: leading slashes and backslashes
 * collapse to one, since `//host` and `/\host` name another host to a browser.
 */
export function localLocation(pathname: string, search = ''): string {
  return pathname.replace(/^[/\\]+/, '/') + search;
}
