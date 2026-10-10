/**
 * Type guarantees of layouts — checked by `tsc` (`pnpm typecheck`, `marmeon build`), never run.
 * A page gets its layout as a plain property: no cast, no wrapper.
 */
import { Link, type DefaultLayout, type LayoutProps, type PageComponent, type PageLayout } from '@marmeon/react';
import type { ReactNode } from 'react';
import { SettingsLayout } from '../modules/auth/layouts/SettingsLayout.tsx';
import { AppLayout } from './AppLayout.tsx';

// A function declaration, and an arrow function: the property is part of their type.
export default function Show({ name }: { name: string }) {
  return <p>{name}</p>;
}
Show.layout = AppLayout;
export const Nested = () => <Link route="auth.security">Security</Link>;
Nested.layout = [AppLayout, SettingsLayout];
export const pages: PageComponent[] = [Show, Nested];

// Checked where it is set, with `satisfies`:
export function Settings() {
  return null;
}
Settings.layout = [AppLayout, SettingsLayout] satisfies PageLayout;
export function NoLayout() {
  return null;
}
NoLayout.layout = null satisfies PageLayout; // not even the app's default

function TitledLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      {children}
    </section>
  );
}
function WithoutChildren(_props: LayoutProps) {
  return null;
}

export function Wrong() {
  return null;
}
// @ts-expect-error — a layout gets only `children`; one that needs more props cannot be a layout
Wrong.layout = TitledLayout satisfies PageLayout;
export function AlsoWrong() {
  return null;
}
// @ts-expect-error — a page name is no layout
AlsoWrong.layout = ['AppLayout'] satisfies PageLayout;
// A page with a wrong layout is no page component (where pages are collected as such).
// @ts-expect-error — Type 'string' is not assignable to type 'PageLayout | undefined'
export const notAPage: PageComponent = Object.assign(() => null, { layout: 'AppLayout' });

// The app's default: by page name, a layout, a list, or null.
export const byName: DefaultLayout = (name) => (name.startsWith('auth/') ? [AppLayout, SettingsLayout] : name === 'errors/Error' ? null : AppLayout);
export const ignoringChildren: DefaultLayout = () => WithoutChildren;
// @ts-expect-error — a default layout is a component, not a name
export const byString: DefaultLayout = () => 'AppLayout';
