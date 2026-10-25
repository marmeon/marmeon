// Type guarantees of a layout's `error` — checked by `tsc` (pnpm build / typecheck), never run.
import type { ReactNode } from 'react';
import type { ErrorFallback, ErrorFallbackProps, Layout, PageLayout } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
  return undefined;
}

function Frame({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}

function FrameError(props: ErrorFallbackProps) {
  return <button onClick={props.retry}>{props.title}</button>;
}
Frame.error = FrameError;

function Broken({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}
Broken.error = 42;

export function layoutErrors() {
  const fine = Frame satisfies PageLayout;
  // @ts-expect-error — `error` is a component, not a number
  const bad = Broken satisfies PageLayout;
  // @ts-expect-error — a fallback gets the error page's props and `retry`, nothing else
  const unknown: ErrorFallback = (props) => <p>{props.nothing}</p>;
  const retry: ErrorFallbackProps['retry'] = () => undefined;
  assert<Equal<ReturnType<ErrorFallbackProps['retry']>, void>>();
  const layout: Layout = Frame;
  return [fine, bad, unknown, retry, layout];
}
