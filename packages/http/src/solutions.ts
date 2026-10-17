import { defineSolutions } from '@marmeon/core';
import { RouteAccessError, Router } from '@marmeon/router';

const UNDEFINED_ROUTE = /^\[marmeon:H4\] Route \[([^\]]+)\] is not defined\.$/;
const MISSING_PAGE = /^\[marmeon:R2\] Page \[([^\]]+)\] not found/;

/**
 * Solutions for HTTP errors: routes that do not say who may call them (H3), a route name that is not defined ("did you mean" from the app's routes) and a page whose
 * view is missing (R2). Text only — the error page shows them in development.
 */
export const httpSolutions = defineSolutions([
  {
    for: RouteAccessError,
    code: 'H3',
    solve: () => ({
      title: 'Say who may call each route',
      text:
        'Every route needs a decision: Route.authorize(can(Policy, \'ability\', \'param\')) for a policy, Route.authorize((ctx) => …) for a check of your own, ' +
        'or Route.authorize(everyone) when anyone its middleware lets through may call it. The error lists each route and where it was registered.',
      command: 'marmeon route:list',
      docs: 'docs/authorization.md#every-route-decides',
    }),
  },
  {
    for: Error,
    code: 'H4',
    solve: (e, { app }) => {
      const name = UNDEFINED_ROUTE.exec(e.message)![1]!;
      const names = app?.container.has(Router) ? app.container.make(Router).routes.flatMap((route) => route.routeName ?? []) : [];
      const close = closest(name, names);
      return {
        title: close.length > 0 ? `Did you mean "${close[0]}"?` : `Name a route "${name}"`,
        text:
          `No route is named "${name}". ` +
          (close.length > 1 ? `Other routes with a similar name: ${close.slice(1).join(', ')}. ` : '') +
          `Name the route in its module's routes.ts — Route.get('/…', Controller).name('${name.split('.').pop()}') inside its name prefix — ` +
          'or use one of the names "marmeon route:list" shows. Route names are typed: `marmeon route:types` makes a wrong one a type error.',
        command: 'marmeon route:list',
      };
    },
  },
  {
    for: Error,
    code: 'R2',
    solve: (e) => {
      const name = MISSING_PAGE.exec(e.message)![1]!;
      const [module, ...rest] = name.split('/');
      const file = `modules/${module}/views/${rest.join('/') || 'Index'}.tsx`;
      return {
        title: `Create ${file}`,
        text:
          `The controller renders the page [${name}], but there is no view for it. A page is the default export of ${file}: ` +
          `export default function ${rest.at(-1) ?? 'Page'}(props: PageProps<typeof YourController>) { … }. ` +
          'Check the spelling in this.view(…) — page names are typed once `marmeon route:types` ran.',
        command: 'marmeon route:types',
        docs: 'docs/pages.md#where-pages-live',
      };
    },
  },
]);

/** Up to three names close to `name` (edit distance), closest first. */
function closest(name: string, known: readonly string[]): string[] {
  const limit = Math.max(2, Math.floor(name.length / 3));
  return [...new Set(known)]
    .map((candidate) => ({ candidate, d: distance(name, candidate) }))
    .filter(({ d }) => d <= limit)
    .sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
