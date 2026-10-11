import { describe, expect, it } from 'vitest';
import { pageName } from './page.ts';

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
