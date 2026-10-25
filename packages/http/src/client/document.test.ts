// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readAppOrigin } from './document.ts';

afterEach(() => {
  document.head.replaceChildren();
});

const meta = (content: string, extra = '') => `<meta name="marmeon-app-origin" content="${content}"${extra}>`;

describe('readAppOrigin', () => {
  it('reads the origin the server wrote', () => {
    document.head.innerHTML = meta('https://app.example');
    expect(readAppOrigin()).toBe('https://app.example');
  });

  it('reduces the content to an origin and takes only http(s)', () => {
    document.head.innerHTML = meta('https://app.example/path?x=1');
    expect(readAppOrigin()).toBe('https://app.example');
    document.head.innerHTML = meta('javascript:alert(1)');
    expect(readAppOrigin()).toBeUndefined();
    document.head.innerHTML = meta('not a url');
    expect(readAppOrigin()).toBeUndefined();
  });

  it('skips a tag a <Head> wrote', () => {
    document.head.innerHTML = meta('https://evil.example', ' data-marmeon-head="client"') + meta('https://app.example');
    expect(readAppOrigin()).toBe('https://app.example');
    document.head.innerHTML = meta('https://evil.example', ' data-marmeon-head="ssr"');
    expect(readAppOrigin()).toBeUndefined();
  });

  it('is undefined without a tag', () => {
    expect(readAppOrigin()).toBeUndefined();
  });
});
