import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { takeFlash } from './client/flash.ts';
import { mergePage } from './client/merge.ts';
import { isPageObject, PROTOCOL_VERSION, type PageObject } from './protocol.ts';

const formats = join(import.meta.dirname, '__fixtures__', 'formats');
const fixtures = (format: string) => readdirSync(join(formats, format)).sort().map((file) => ({ file, value: JSON.parse(readFileSync(join(formats, format, file), 'utf8')) as unknown }));

describe('the page protocol: the fixtures of every version it once spoke', () => {
  it('speaks the version its fixtures are of', () => {
    expect(PROTOCOL_VERSION).toBe('1');
    for (const format of ['page-object', 'region-object']) {
      expect(fixtures(format).length).toBeGreaterThan(0);
      for (const { file } of fixtures(format)) expect(file).toMatch(/^v1(-[a-z-]+)?\.json$/);
    }
  });

  for (const format of ['page-object', 'region-object']) {
    it.each(fixtures(format).map((fixture) => [fixture.file, fixture.value] as const))(`${format}/%s is read by the client: a page, merged, its flash taken`, (_file, value) => {
      expect(isPageObject(value)).toBe(true);
      const page = value as PageObject;
      // A partial reload brings one prop and the marks of its own: nothing throws, the rest of the page stays.
      const merged = mergePage(page, { ...page, props: { ...page.props, extra: 1 } });
      expect(merged.component).toBe(page.component);
      expect(merged.url).toBe(page.url);
      expect(merged.props).toMatchObject({ ...page.props, extra: 1 });
      const taken = takeFlash(page);
      expect(taken.page.flash).toBeUndefined();
      expect(taken.flash).toEqual(page.flash ?? []);
    });
  }

  it('a page object the client does not recognise is none: a body without a component, props or url', () => {
    for (const value of [null, 'page', 1, {}, { component: 'a', props: {} }, { props: {}, url: '/' }, { component: 'a', url: '/' }]) expect(isPageObject(value)).toBe(false);
  });

  it('a field of a later version is carried along and does not hide the page', () => {
    const minimal = fixtures('page-object').find(({ file }) => file === 'v1-minimal.json')!.value as PageObject;
    const later = { ...minimal, aFieldOfALaterVersion: { x: 1 } };
    expect(isPageObject(later)).toBe(true);
    expect(mergePage(later as PageObject, later as PageObject)).toMatchObject({ aFieldOfALaterVersion: { x: 1 } });
  });
});
