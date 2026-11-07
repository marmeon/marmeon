// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevtoolsReplica } from './DevtoolsReplica.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root.render(<DevtoolsReplica />));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const tab = (name: string) => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent === name)!;
const panel = (name: string) => document.getElementById(tab(name).getAttribute('aria-controls')!)!;

describe('DevtoolsReplica with JavaScript', () => {
  it('has two tablists, the pages and the bar, each showing its first tab', () => {
    expect([...container.querySelectorAll('[role="tablist"]')].map((list) => list.getAttribute('aria-label'))).toEqual(['Devtools pages', 'Devtools bar']);
    expect(panel('Requests').hidden).toBe(false);
    expect(panel('Queries').hidden).toBe(true);
    expect(panel('Visits').hidden).toBe(false);
  });

  it('shows the Queries table after a click on Queries', async () => {
    await act(async () => tab('Queries').click());
    expect(panel('Queries').hidden).toBe(false);
    expect(panel('Requests').hidden).toBe(true);
    expect(panel('Queries').querySelector('th')?.textContent).toBe('Time');
    expect(panel('Queries').textContent).toContain('select count(*) from guests');
  });

  it('shows the island row after a click on Layers & regions', async () => {
    await act(async () => tab('Layers & regions').click());
    expect(panel('Layers & regions').hidden).toBe(false);
    expect(panel('Layers & regions').textContent).toContain('/islands/render-clock');
    expect(panel('Layers & regions').textContent).toContain('site/islands/RenderClock');
  });
});
