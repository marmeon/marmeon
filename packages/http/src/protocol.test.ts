import { describe, expect, expectTypeOf, it } from 'vitest';
import * as page from './page.ts';
import * as protocol from './protocol.ts';
import type { PageObject, RegionObject } from './protocol.ts';

describe('@marmeon/http/protocol', () => {
  it('carries the headers and the checks that read them', () => {
    expect(protocol.PAGE_HEADER).toBe('x-marmeon');
    expect(protocol.UPLOAD_HEADER).toBe('x-marmeon-upload');
    expect(protocol.PAGE_SCRIPT_ID).toBe('marmeon-page');
    expect(protocol.regionOf(new Request('http://localhost/', { headers: { [protocol.PAGE_HEADER]: 'true', [protocol.REGION_HEADER]: 'island' } }))).toBe('island');
    expect(protocol.isPrefetch(new Request('http://localhost/', { headers: { [protocol.PURPOSE_HEADER]: 'prefetch' } }))).toBe(true);
    expect(protocol.isPageObject({ component: 'a/B', props: {}, url: '/' })).toBe(true);
  });

  it('@marmeon/http/page has no protocol names — it holds the app side', () => {
    const exported = Object.keys(page);
    expect(exported.filter((name) => name.endsWith('_HEADER'))).toEqual([]);
    expect(exported).not.toContain('PAGE_SCRIPT_ID');
    expect(exported).not.toContain('isPageObject');
    expect(exported).toContain('pageInfo');
    expect(exported).toContain('LAYER_BACKDROP');
  });

  it('types the wire objects the page side builds on', () => {
    expectTypeOf(page.pageInfo).parameter(0).toEqualTypeOf<PageObject>();
    expectTypeOf<RegionObject>().toEqualTypeOf<Omit<PageObject, 'locale' | 'fallbackLocale' | 'streamedProps' | 'layer' | 'layers' | 'flash'>>();
  });
});
