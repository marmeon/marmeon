import { describe, expect, it } from 'vitest';
import { legacyFrameworkPage, pageName } from './page-support.ts';

describe('pageName', () => {
  it('names only the views of the app’s own modules', () => {
    expect(pageName('node_modules/x/modules/a/views/B.tsx')).toBeUndefined();
    expect(pageName('/node_modules/x/modules/a/views/B.tsx')).toBeUndefined();
    expect(pageName('src/modules/a/views/B.tsx')).toBeUndefined();
    expect(pageName('../modules/a/views/B.tsx')).toBeUndefined();
    expect(pageName('modules/a/B.tsx')).toBeUndefined();
    expect(pageName('modules/a/views/B.css')).toBeUndefined();
  });

  it('turns modules/<module>/views/<Page> into <module>/<Page>', () => {
    expect(pageName('modules/a/views/B.tsx')).toBe('a/B');
    expect(pageName('/modules/a/views/sub/C.tsx')).toBe('a/sub/C');
    expect(pageName('modules/user-profile/views/Show.jsx')).toBe('user-profile/Show');
    expect(pageName('modules\\a\\views\\sub\\D.tsx')).toBe('a/sub/D');
  });
});

describe('legacyFrameworkPage', () => {
  it('maps the former places of the error pages and the layer backdrop to the system module', () => {
    expect(legacyFrameworkPage('modules/errors/views/Error.tsx')).toBe('modules/system/views/errors/Error.tsx');
    expect(legacyFrameworkPage('modules/errors/views/Error.jsx')).toBe('modules/system/views/errors/Error.tsx');
    expect(legacyFrameworkPage('modules/errors/views/404.tsx')).toBe('modules/system/views/errors/404.tsx');
    expect(legacyFrameworkPage('modules\\errors\\views\\500.jsx')).toBe('modules/system/views/errors/500.tsx');
    expect(legacyFrameworkPage('modules/layers/views/Backdrop.tsx')).toBe('modules/system/views/layers/Backdrop.tsx');
  });

  it('leaves every other file alone', () => {
    expect(legacyFrameworkPage('modules/errors/views/List.tsx')).toBeUndefined();
    expect(legacyFrameworkPage('modules/errors/views/4044.tsx')).toBeUndefined();
    expect(legacyFrameworkPage('modules/errors/views/sub/404.tsx')).toBeUndefined();
    expect(legacyFrameworkPage('modules/layers/views/Other.tsx')).toBeUndefined();
    expect(legacyFrameworkPage('modules/system/views/errors/Error.tsx')).toBeUndefined();
  });
});
