/**
 * Route patterns every place that reads one is held to: the server's matching, `fillPath`, the browser's `matchesPath`,
 * the check of `Route.bind()` and the sitemap. `names` are the parameters in order, `filled` the path `fillPath` builds from
 * `params`, `matches` and `misses` paths the pattern accepts and refuses (with the parameters read from a match).
 */
export interface PatternCase {
  readonly pattern: string;
  readonly names: readonly string[];
  readonly params: Readonly<Record<string, string | number>>;
  readonly filled: string;
  readonly matches: readonly { readonly path: string; readonly params: Readonly<Record<string, string>> }[];
  readonly misses: readonly string[];
}

export const ROUTE_PATTERNS: readonly PatternCase[] = [
  { pattern: '/users/:id', names: ['id'], params: { id: 7 }, filled: '/users/7', matches: [{ path: '/users/7', params: { id: '7' } }], misses: ['/users', '/users/7/x'] },
  {
    pattern: '/archive/:year{[0-9]{4}}',
    names: ['year'],
    params: { year: 2026 },
    filled: '/archive/2026',
    matches: [{ path: '/archive/2026', params: { year: '2026' } }],
    misses: ['/archive/26', '/archive/2026}', '/archive/20266'],
  },
  {
    pattern: '/archive/:year{[0-9]{4}}/:month{[0-9]{2}}?',
    names: ['year', 'month'],
    params: { year: 2026, month: '07' },
    filled: '/archive/2026/07',
    matches: [
      { path: '/archive/2026', params: { year: '2026' } },
      { path: '/archive/2026/07', params: { year: '2026', month: '07' } },
    ],
    misses: ['/archive/2026/7', '/archive/2026}/07'],
  },
  {
    pattern: '/docs/:kind{new|edit}',
    names: ['kind'],
    params: { kind: 'edit' },
    filled: '/docs/edit',
    matches: [
      { path: '/docs/new', params: { kind: 'new' } },
      { path: '/docs/edit', params: { kind: 'edit' } },
    ],
    misses: ['/docs/newedit', '/docs/new/edit', '/docs/ed'],
  },
  {
    pattern: '/raw/:text{[}]+}',
    names: ['text'],
    params: { text: '}}' },
    filled: '/raw/%7D%7D',
    matches: [{ path: '/raw/}}', params: { text: '}}' } }],
    misses: ['/raw/a', '/raw/}a'],
  },
  {
    pattern: '/blog/:slug/:page?',
    names: ['slug', 'page'],
    params: { slug: 'a b' },
    filled: '/blog/a%20b',
    matches: [
      { path: '/blog/hello', params: { slug: 'hello' } },
      { path: '/blog/hello/2', params: { slug: 'hello', page: '2' } },
    ],
    misses: ['/blog', '/blog/hello/2/3'],
  },
  {
    pattern: '/files/v1.0/:name_2/:_rest',
    names: ['name_2', '_rest'],
    params: { name_2: 'a', _rest: 'b' },
    filled: '/files/v1.0/a/b',
    matches: [{ path: '/files/v1.0/a/b', params: { name_2: 'a', _rest: 'b' } }],
    misses: ['/files/v1x0/a/b', '/files/v1.0/a'],
  },
  { pattern: '/about', names: [], params: {}, filled: '/about', matches: [{ path: '/about', params: {} }], misses: ['/about/x'] },
];

/** Patterns the router cannot read the same way everywhere: they stop the start, saying `problem`. */
export const INVALID_PATTERNS: readonly { readonly pattern: string; readonly problem: string }[] = [
  { pattern: '/users/:user-id', problem: 'is no name' },
  { pattern: '/users/:1st', problem: 'is no name' },
  { pattern: '/users/:user.id', problem: 'is no name' },
  { pattern: '/users/:', problem: 'is no name' },
  { pattern: '/users/:a-b{[0-9]+}', problem: 'is no name' },
  { pattern: '/users/:a-b?', problem: 'is no name' },
  { pattern: '/a/:id/b/:id', problem: 'appears twice' },
  { pattern: '/a/:id/b/:id?', problem: 'appears twice' },
  { pattern: '/a/:b{[0-9]', problem: 'never closed' },
  { pattern: '/a/:b{[0-9]{2}', problem: 'never closed' },
  { pattern: '/a/:x{[a-z]+}.json', problem: 'followed by text in its segment' },
  { pattern: '/a/:x.json', problem: 'is no name' },
  { pattern: '/a/:x?.json', problem: 'is not last' },
  { pattern: '/a/:x-:y', problem: 'is no name' },
  { pattern: '/a/:x?/b', problem: 'is not last' },
  { pattern: '/a/:x?/:y', problem: 'is not last' },
  { pattern: '/a/:x{[a-z]+}?/b', problem: 'is not last' },
  { pattern: '/a/:x{(?<year>[0-9]{4})}', problem: 'names a group' },
];
