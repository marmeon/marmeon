// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './CodeBlock.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = '<pre class="code"><span class="tk">const</span> x = 1;\n</pre>';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount(props: { caption?: string; copy?: boolean }) {
  await act(async () => root.render(<CodeBlock html={html} {...props} />));
}

describe('CodeBlock copy button after hydration', () => {
  it.each([{}, { caption: 'x.ts' }])('is present by default (%o)', async (props) => {
    await mount(props);
    expect(container.querySelectorAll('.copy-button')).toHaveLength(1);
  });

  it.each([{ copy: false }, { copy: false, caption: 'x.ts' }])('is left out with copy={false} (%o)', async (props) => {
    await mount(props);
    expect(container.querySelector('.copy-button')).toBeNull();
    expect(container.querySelector('.code-block')).not.toBeNull();
  });
});
