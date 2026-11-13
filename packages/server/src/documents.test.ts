import { describe, expect, it } from 'vitest';
import { documentFor, packageTemplate, PACKAGE_ENTRY_MARK, UnknownEntryError } from './documents.ts';
import { withNonce } from './html.ts';

const table = { entries: new Set(['status']) };

describe('documentFor', () => {
  it("is the app's for a view without a namespace", () => {
    expect(documentFor('users/Show', table)).toBe('app');
    expect(documentFor('users/Show', { entries: new Set<string>() })).toBe('app');
  });

  it("is the entry's for a package with one", () => {
    expect(documentFor('status::Index', table)).toBe('status');
    expect(documentFor('status::entries/Edit', table)).toBe('status');
  });

  it('refuses an unknown namespace with H16 — never the app document', () => {
    expect(() => documentFor('nope::X', table)).toThrow(UnknownEntryError);
    // A package without an entry has no document either.
    expect(() => documentFor('help::Article', table)).toThrow(/^\[marmeon:H16\] /);
    expect(() => documentFor('nope::X', table)).toThrow(/^\[marmeon:H16\] /);
    // The name is read up to the first `::` only; a namespace that merely starts like another is another.
    expect(() => documentFor('statusx::X', table)).toThrow(UnknownEntryError);
    expect(() => documentFor('::X', table)).toThrow(UnknownEntryError);
  });
});

describe('packageTemplate', () => {
  const html = packageTemplate({ script: '/assets/pkg-status-a.js', preloads: ['/assets/shared-b.js'], stylesheets: ['/assets/pkg-status-c.css'] });

  it('carries the entry script, stylesheets and preloads, each with the nonce — and the mark that keeps the app client out', () => {
    const nonced = withNonce(html, 'N0NCE');
    expect(nonced).toContain('<script type="module" async crossorigin src="/assets/pkg-status-a.js" nonce="N0NCE"></script>');
    expect(nonced).toContain('<link rel="stylesheet" crossorigin href="/assets/pkg-status-c.css" nonce="N0NCE">');
    expect(nonced).toContain('<link rel="modulepreload" crossorigin href="/assets/shared-b.js" nonce="N0NCE">');
    expect(nonced).toContain(PACKAGE_ENTRY_MARK);
    expect(nonced).not.toContain('__marmeon_csp_nonce__');
    // The tags stand before the head outlet, which `<Head>` fills.
    expect(nonced.indexOf('pkg-status-a.js')).toBeLessThan(nonced.indexOf('<!--app-head-->'));
  });

  it('writes no nonce attribute without one', () => {
    expect(withNonce(html, undefined)).not.toContain('nonce');
  });

  it('escapes what goes into an attribute', () => {
    expect(packageTemplate({ script: '/a"><b', preloads: [], stylesheets: [] })).not.toContain('"><b');
  });
});
