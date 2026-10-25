// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { PAGE_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { loadHistoryFallback, loadInstant, type Navigator } from '@marmeon/http/client/adapter';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, useRouterContext } from './app.tsx';
import { layoutsOf, resolveModulePages, type ErrorFallbackProps, type PageComponent } from './pages.ts';

const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let navigator: Navigator | null = null;

function Outer({ children }: { children: ReactNode }) {
  navigator = useRouterContext().navigator();
  return <div data-layout="outer">{children}</div>;
}
function OuterError(props: ErrorFallbackProps) {
  return (
    <p data-fallback="outer">
      {props.title}
      <button data-testid="retry-outer" onClick={props.retry} />
    </p>
  );
}
Outer.error = OuterError;

function Inner({ children }: { children: ReactNode }) {
  return <section data-layout="inner">{children}</section>;
}
function InnerError(props: ErrorFallbackProps) {
  return (
    <p data-fallback="inner">
      {props.title} · {props.message} · {props.exception ? 'details' : 'no details'}
      <button data-testid="retry-inner" onClick={props.retry} />
    </p>
  );
}
Inner.error = InnerError;

/** Throws while `broken` is set — like a page whose data arrived in another shape. */
function Boom({ broken }: { broken: boolean }) {
  if (broken) throw new Error('the page broke');
  return <p data-page="boom">Fine</p>;
}
Boom.layout = [Outer, Inner];

function Slow() {
  return <p data-page="slow">Slow</p>;
}
Slow.layout = [Outer, Inner];
Slow.placeholder = () => <p data-placeholder="slow">Loading</p>;

function InnerThrows(): never {
  throw new Error('the layout broke');
}
function Nested() {
  return <p data-page="nested">Nested</p>;
}
Nested.layout = [Outer, InnerThrows];

function Plain({ children }: { children: ReactNode }) {
  return <div data-layout="plain">{children}</div>;
}
function Broken({ broken }: { broken: boolean }) {
  if (broken) throw new Error('the page broke');
  return <p data-page="broken">Fine</p>;
}
Broken.layout = Plain;

const pages: Record<string, PageComponent> = { Boom, Nested, Broken, Slow };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const respond = (body: PageObject) => new Response(JSON.stringify(body), { status: 200, headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });

let server: () => Response | Promise<Response>;
let root: Root;
let container: HTMLElement;
const $ = (selector: string) => container.querySelector(selector);
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 10))));
const click = (testId: string) => act(async () => ($(`[data-testid="${testId}"]`) as HTMLButtonElement).click());

beforeEach(() => {
  history.replaceState(null, '', '/a');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  vi.spyOn(window, 'fetch').mockImplementation(async () => server());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => {
    root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} />);
  });
  await settle();
}

describe('a layout with error', () => {
  it('shows the failure of its page inside itself, within the layouts around it, and retry loads the page again', async () => {
    let requests = 0;
    server = () => {
      requests++;
      return respond(page('Boom', '/a', { broken: requests < 3 }));
    };
    await mount(page('Boom', '/a', { broken: true }));

    expect(requests).toBe(1); // the one automatic fresh copy, which fails again
    expect($('[data-layout="outer"] [data-layout="inner"] [data-fallback="inner"]')!.textContent).toContain('Something went wrong');
    expect($('[data-fallback="inner"]')!.textContent).toContain('the page broke · details'); // development: the exception
    expect($('[data-fallback="outer"]')).toBeNull(); // the nearest layout with error, not the outer one

    await click('retry-inner');
    await settle();
    expect(requests).toBe(2); // one reload per click, no loop
    expect($('[data-fallback="inner"]')).not.toBeNull();

    await click('retry-inner');
    await settle();
    expect(requests).toBe(3);
    expect($('[data-fallback]')).toBeNull();
    expect($('[data-layout="inner"] [data-page="boom"]')!.textContent).toBe('Fine');
  });

  it('shows the placeholder of an instant visit over a fallback that stays from the page before', async () => {
    server = () => respond(page('Boom', '/a', { broken: true }));
    await mount(page('Boom', '/a', { broken: true }));
    expect($('[data-fallback="inner"]')).not.toBeNull();

    let answer!: () => void;
    server = () => new Promise((done) => (answer = () => done(respond(page('Slow', '/slow')))));
    await navigator!.load(loadInstant);
    const landed = navigator!.visit('/slow', { instant: { component: 'app/Slow' } });
    await settle();
    expect($('[data-placeholder="slow"]')).not.toBeNull();
    expect($('[data-fallback]')).toBeNull();

    answer();
    await landed;
    await settle();
    expect($('[data-page="slow"]')).not.toBeNull();
  });

  it('hands the failure of a layout inside it to the layout above that has error', async () => {
    server = () => respond(page('Nested', '/a'));
    await mount(page('Nested', '/a'));
    expect($('[data-layout="outer"] [data-fallback="outer"]')!.textContent).toContain('Something went wrong');
    expect($('[data-page="nested"]')).toBeNull();
  });

  it('leaves layouts without error as they are: the error page inside them', async () => {
    server = () => respond(page('Broken', '/a', { broken: true }));
    await mount(page('Broken', '/a', { broken: true }));
    expect($('[data-layout="plain"] h1')!.textContent).toBe('Something went wrong');
    expect($('[data-fallback]')).toBeNull();
  });

  it('refuses an error that is no component (R19)', async () => {
    const Bad = () => null;
    Bad.error = 'nope';
    const View = () => null;
    View.layout = Bad;
    const bad = resolveModulePages({ '/modules/app/views/View.tsx': async () => ({ default: View }) });
    await expect(bad('app/View')).rejects.toThrow(/\[marmeon:R19\] Page \[app\/View\] has a layout whose error is no component/);
  });

  it('throws R19 while a page resolves its default layout', () => {
    const Bad = () => null;
    Bad.error = 'nope';
    const View = () => null;
    expect(() => layoutsOf(View, 'app/View', () => Bad as never)).toThrow(/\[marmeon:R19\] Page \[app\/View\] has a layout whose error is no component/);
    expect(() => layoutsOf(View, 'app/View', () => [Outer, Bad] as never)).toThrow(/at index 1 whose error is no component/);
    expect(() => layoutsOf(View, 'app/View', () => 'nope' as never)).toThrow(/\[marmeon:R1\]/);
  });
});
