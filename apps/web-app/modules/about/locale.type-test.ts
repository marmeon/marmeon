// What a localized route's `locale` means for redirects and URLs — checked by `tsc` (pnpm typecheck), never run.
import { RedirectResult } from '@marmeon/http';
import type { Router } from '@marmeon/router';

declare const router: Router;

// A redirect to a localized route takes the request's locale: it may be left out, or given.
new RedirectResult().route('about.index');
new RedirectResult().route('about.index', { locale: 'de' });
new RedirectResult().route('about.features.show', { feature: 'typed-routes' });
// @ts-expect-error — the other parameters of a localized route stay required.
new RedirectResult().route('about.features.show');

// A URL never guesses: the locale is required.
router.url('about.index', { locale: 'de' });
// @ts-expect-error — `Router.url()` needs the locale.
router.url('about.index');
// @ts-expect-error — `Router.url()` needs the locale.
router.url('about.features.show', { feature: 'typed-routes' });
