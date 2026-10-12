// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { followVisualViewport } from './follow-visual-viewport.ts';

function fakeViewport(offsetTop: number, height: number) {
  const target = new EventTarget();
  return Object.assign(target, { offsetTop, height }) as EventTarget & { offsetTop: number; height: number };
}

describe('followVisualViewport', () => {
  it('sets the visible area, follows resize and scroll, and lets go on cleanup', () => {
    const element = document.createElement('dialog');
    const viewport = fakeViewport(0, 800);
    const stop = followVisualViewport(element, viewport as unknown as VisualViewport);
    expect(element.style.getPropertyValue('--vv-height')).toBe('800px');
    viewport.height = 450;
    viewport.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue('--vv-height')).toBe('450px');
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
    expect(element.style.getPropertyValue('--vv-top')).toBe('120px');
    stop();
    viewport.offsetTop = 5;
    viewport.dispatchEvent(new Event('scroll'));
    expect(element.style.getPropertyValue('--vv-top')).toBe('');
  });

  it('does nothing without a visual viewport', () => {
    const element = document.createElement('dialog');
    followVisualViewport(element, undefined)();
    expect(element.style.getPropertyValue('--vv-top')).toBe('');
  });
});
