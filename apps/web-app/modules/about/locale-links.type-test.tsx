// What a localized route's `locale` means in the browser — checked by `tsc` (pnpm typecheck), never run.
import { Link, useRoute } from '@marmeon/react';

export function Links() {
  const route = useRoute();
  return (
    <>
      {/* The page's own locale is the default: it may be left out, or given. */}
      <Link route="about.index">About</Link>
      <Link route="about.index" params={{ locale: 'de' }}>Über</Link>
      <Link route="about.features.show" params={{ feature: 'typed-routes' }}>One</Link>
      {/* @ts-expect-error — the other parameters of a localized route stay required. */}
      <Link route="about.features.show">One</Link>
      {/* @ts-expect-error — a parameter the path lacks. */}
      <Link route="about.index" params={{ other: 'x' }}>About</Link>
      <a href={route('about.index')}>{route('about.features.show', { feature: 'typed-routes' })}</a>
      <a href={route('about.index', { locale: 'de' })}>{route('about.index', { locale: 'de' }, { tab: 'x' })}</a>
      {/* @ts-expect-error — the feature is required. */}
      <a href={route('about.features.show')}>One</a>
    </>
  );
}
