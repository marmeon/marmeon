import { isNamespace, isViewName } from '@marmeon/core/internal';
import { describe, expect, it } from 'vitest';
import { isPackagePageName } from './page-support.ts';

describe('isPackagePageName', () => {
  it('accepts <namespace>::<view>', () => {
    for (const key of ['status::Index', 'status::entries/Edit', 'status-board2::a_b/C-d', `${'a'.repeat(32)}::X`]) expect(isPackagePageName(key)).toBe(true);
  });

  it('agrees with isNamespace and isViewName on hostile samples', () => {
    const namespaces = ['a'.repeat(32), 'a'.repeat(33), 'app', 'marmeon', 'Status', 'a--b', '-a', '1a', '', 'a b', 'a"b', 'x\ny', 'a_b', 'app-x', 'appx', 'marmeonx'];
    const views = ['Index', 'a/b', '', 'a//b', '/a', 'a/', '..', 'a/../b', 'a"b', 'a b', "a'b", 'a\nb', 'a::b'];
    for (const namespace of namespaces) {
      for (const view of views) {
        expect(isPackagePageName(`${namespace}::${view}`), JSON.stringify(`${namespace}::${view}`)).toBe(isNamespace(namespace) && isViewName(view));
      }
    }
    for (const key of ['a::b::c', 'status', 'status:Index', '/modules/a/views/x::y.tsx']) expect(isPackagePageName(key)).toBe(false);
  });
});
