// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readAppOrigin, readInitialPage, rootElement } from './document.ts';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  // @ts-expect-error -- removes the own property a test put on `document`
  delete document.getElementById;
  // @ts-expect-error -- removes the own property a test put on `document`
  delete document.head;
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

  it('reads the real head, not an element that named itself document.head', () => {
    document.head.innerHTML = meta('https://app.example');
    // What `<img name="head">` / `<form name="head">` does in a browser: the property reads as the attacker's element.
    const decoy = document.createElement('form');
    decoy.innerHTML = meta('https://evil.example');
    Object.defineProperty(document, 'head', { configurable: true, value: decoy });
    expect(readAppOrigin()).toBe('https://app.example');
  });
});

const PAGE = '{"component":"Home","props":{},"url":"/","version":null}';
const shadowGetElementById = (decoy: Element) =>
  Object.defineProperty(document, 'getElementById', { configurable: true, value: () => decoy });

describe('readInitialPage', () => {
  it('reads the page object of an ordinary page', () => {
    document.head.innerHTML = `<script id="marmeon-page" type="application/json">${PAGE}</script>`;
    expect(readInitialPage()).toMatchObject({ component: 'Home' });
  });

  it('ignores a getElementById that named elements put in place of the real one', () => {
    document.head.innerHTML = `<script id="marmeon-page" type="application/json">${PAGE}</script>`;
    const decoy = document.createElement('script');
    decoy.type = 'application/json';
    decoy.textContent = PAGE.replace('Home', 'Evil');
    shadowGetElementById(decoy);
    expect(readInitialPage()).toMatchObject({ component: 'Home' });
  });

  it('refuses an SVG or MathML script that carries the id', () => {
    for (const namespace of ['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML']) {
      document.head.replaceChildren();
      const decoy = document.createElementNS(namespace, 'script');
      decoy.setAttribute('id', 'marmeon-page');
      decoy.setAttribute('type', 'application/json');
      decoy.textContent = PAGE.replace('Home', 'Evil');
      document.body.replaceChildren(decoy);
      expect(() => readInitialPage()).toThrow(/Missing or invalid/);
    }
  });
});

describe('rootElement', () => {
  it('finds the root through the real getElementById', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    shadowGetElementById(document.createElement('div'));
    expect(await rootElement('app')).toBe(document.body.firstElementChild);
  });
});
