// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { streamedText } from './streamed.tsx';

afterEach(() => document.body.replaceChildren());

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
});
