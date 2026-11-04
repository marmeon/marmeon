// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { streamedText } from './streamed.tsx';

afterEach(() => {
  document.body.replaceChildren();
  // @ts-expect-error -- removes the own property a test put on `document`
  delete document.scripts;
});

const ID = 'marmeon-island-:r1:';
const SERVER = '{"status":"ready","region":{"component":"Real"}}';
const DECOY = '{"status":"ready","region":{"component":"Evil"}}';

describe('streamedText', () => {
  it('reads the data script even behind an element with the same id', () => {
    document.body.innerHTML =
      '<div id="marmeon-island-:r1:">{"component":"Admin","props":{}}</div>' +
      '<script type="application/json" id="marmeon-island-:r1:">{"status":"ready"}</script>';
    expect(streamedText('marmeon-island-:r1:')).toBe('{"status":"ready"}');
  });

  it('takes nothing from an element that is not a data script', () => {
    document.body.innerHTML = '<div id="marmeon-island-:r1:">{"component":"Admin","props":{}}</div>';
    expect(streamedText('marmeon-island-:r1:')).toBeUndefined();
  });

  it('ignores a collection that named elements put in place of document.scripts', () => {
    document.body.innerHTML = `<script type="application/json" id="${ID}">${SERVER}</script>`;
    // What `<form name="scripts">` does in a browser: the property reads as the attacker's collection.
    const decoy = document.createElement('script');
    decoy.type = 'application/json';
    decoy.id = ID;
    decoy.textContent = DECOY;
    Object.defineProperty(document, 'scripts', { configurable: true, value: { namedItem: () => decoy, 0: decoy, length: 1 } });
    expect(streamedText(ID)).toBe(SERVER);
  });

  it('ignores an SVG or MathML script with the same id ahead of the real block', () => {
    document.body.innerHTML = `<script type="application/json" id="${ID}">${SERVER}</script>`;
    // Built as elements: the namespace is what a sanitiser-passed `<svg><script>` ends up with in a browser.
    for (const namespace of ['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML']) {
      const decoy = document.createElementNS(namespace, 'script');
      decoy.setAttribute('type', 'application/json');
      decoy.setAttribute('id', ID);
      decoy.textContent = DECOY;
      document.body.prepend(decoy);
    }
    expect(streamedText(ID)).toBe(SERVER);
  });

  it('takes nothing when only a foreign script carries the id', () => {
    const decoy = document.createElementNS('http://www.w3.org/2000/svg', 'script');
    decoy.setAttribute('type', 'application/json');
    decoy.setAttribute('id', ID);
    decoy.textContent = DECOY;
    document.body.append(decoy);
    expect(streamedText(ID)).toBeUndefined();
  });

  it('finds an ordinary block', () => {
    document.body.innerHTML = `<script type="application/json" id="other">{}</script><script type="application/json" id="${ID}">${SERVER}</script>`;
    expect(streamedText(ID)).toBe(SERVER);
  });
});
