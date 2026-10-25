import { describe, expect, it } from 'vitest';
import { collectRouteReferences } from './route-references.ts';

const NAMES = ['auth.login', 'auth.logout', 'user-profile.edit', 'user-profile.links.destroy', 'user-profile.me', 'user-profile.show', 'user-profile.update'];

function collect(code: string, filename = 'modules/demo/views/Page.tsx') {
  const { references, problems } = collectRouteReferences(code, filename, { names: NAMES });
  return { names: [...new Set(references.map((reference) => reference.name))].sort(), problems: problems.map((problem) => problem.message) };
}

describe('collectRouteReferences', () => {
  it('collects the names written out at the sinks: <Link route>, route() of useRoute(), useForm(name, …)', () => {
    const { names, problems } = collect(`
      import { Link, useForm, useRoute } from '@marmeon/react';
      export default function Page({ profile, isOwn }: Props) {
        const route = useRoute();
        const form = useForm('user-profile.update', { name: '' }, { params: { user: profile.id } });
        return (
          <form action={route('auth.login')}>
            <Link route="user-profile.show" params={{ user: profile.id }}>{profile.name}</Link>
            <Link route={isOwn ? 'user-profile.edit' : \`user-profile.me\`}>me</Link>
            <Link href="/elsewhere">no route</Link>
          </form>
        );
      }
    `);
    expect(problems).toEqual([]);
    expect(names).toEqual(['auth.login', 'user-profile.edit', 'user-profile.me', 'user-profile.show', 'user-profile.update']);
  });

  it('collects the route of useQueryState(name, …) — its page needs its pattern', () => {
    const { names, problems } = collect(`
      import { useQueryState } from '@marmeon/react';
      export default function People() {
        const [query, setQuery] = useQueryState('user-profile.show', { only: ['people'], debounceMs: 300 });
        return null;
      }
    `);
    expect(problems).toEqual([]);
    expect(names).toEqual(['user-profile.show']);
    expect(collect(`import { useQueryState } from '@marmeon/react'; export const X = ({ name }) => useQueryState(name);`).problems[0]).toContain(
      'useQueryState()',
    );
  });

  it('collects a layer link’s route — `layer` is a flag, never a name', () => {
    const { names, problems } = collect(`
      import { Link } from '@marmeon/react';
      export default function Page({ profile, asLayer }: Props) {
        return (
          <>
            <Link route="user-profile.edit" params={{ user: profile.id }} layer>Edit</Link>
            <Link route="user-profile.show" params={{ user: profile.id }} layer={asLayer}>Show</Link>
          </>
        );
      }
    `);
    expect(problems).toEqual([]);
    expect(names).toEqual(['user-profile.edit', 'user-profile.show']);
  });

  it('follows import aliases, namespace imports, as const and const bindings in the module', () => {
    const { names, problems } = collect(`
      import { Link as L, useRoute as useUrl } from '@marmeon/react';
      import * as B from '@marmeon/react';
      const LOGOUT = 'auth.logout' as const;
      const TABS = { edit: 'user-profile.edit', show: 'user-profile.show' } as const;
      export function Nav({ tab }: { tab: keyof typeof TABS }) {
        const url = useUrl();
        const login = ('auth.login' satisfies string);
        void B.useForm(LOGOUT, {});
        return <><L route={TABS[tab]} /><B.Link route={TABS.edit} /><a href={url(login)} />{B.useRoute()('user-profile.me')}</>;
      }
    `);
    expect(problems).toEqual([]);
    expect(names).toEqual(['auth.login', 'auth.logout', 'user-profile.edit', 'user-profile.me', 'user-profile.show']);
  });

  it('ignores look-alikes: other packages, shadowed names, useForm(initial), type-only imports', () => {
    const { names, problems } = collect(`
      import { Link } from 'react-router';
      import { useForm as form, type Link as TypeOnly } from '@marmeon/react';
      import { useRoute } from '@marmeon/react';
      export function A({ route }: { route: (name: string) => string }) {
        return <Link route={route(dynamicName)} />;     // the parameter shadows nothing of ours
      }
      export function B() {
        const route = useRoute();
        function inner(route: (name: string) => string) { return route(somewhere); }
        void form({ email: '' });
        return inner;
      }
    `);
    expect(problems).toEqual([]);
    expect(names).toEqual([]);
  });

  it('refuses a name built at runtime — with the literal prefix matched against the routes ("did you mean")', () => {
    const { problems } = collect(`
      import { useRoute } from '@marmeon/react';
      export function Tabs({ tab, user }: Props) {
        const route = useRoute();
        return route(\`user-profile.\${tab}\`, { user });
      }
    `);
    expect(problems).toEqual([
      'route names sent to the browser must be written out: `user-profile.${tab}` (route()) is built at runtime, so the build cannot tell which ' +
        'routes this page needs. Did you mean one of user-profile.edit, user-profile.me, user-profile.show, user-profile.update? ' +
        "Write them as literals, e.g. tab === 'edit' ? 'user-profile.edit' : 'user-profile.me'.",
    ]);
  });

  it('refuses names from props, concatenations, spreads into a sink and the route function called with a spread', () => {
    const { problems } = collect(`
      import { Link, useForm, useRoute } from '@marmeon/react';
      export function Toast({ toast, rest, args }: Props) {
        const route = useRoute();
        useForm('user-profile.' + toast.kind, {});
        route(...args);
        return <><Link route={toast.action.route}>Undo</Link><Link {...rest} /><Link {...rest} href="/ok" /></>;
      }
    `);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("'user-profile.' + toast.kind (useForm()) is built at runtime");
    expect(problems[0]).toContain('Did you mean one of user-profile.edit, user-profile.me, user-profile.show, user-profile.update?');
    expect(problems[1]).toContain('...args (route()) is not known at build time');
    expect(problems[2]).toContain('toast.action.route (<Link route>) is not known at build time');
    expect(problems[2]).toContain('send its URL instead (router.url() on the server), not its name');
    expect(problems[3]).toBe(
      "<Link {...rest}> may carry a route name the build cannot see, so the browser's route manifest would lack it. " +
        'Write route="…" on the <Link> itself (after the spread), or pass a URL as href.',
    );
  });

  it('reports where: each reference and problem has its offset', () => {
    const code = "import { Link } from '@marmeon/react';\nexport const A = () => <Link route={name} />;\n";
    const { problems } = collectRouteReferences(code, 'A.tsx');
    expect(code.slice(problems[0]!.start, problems[0]!.start + 4)).toBe('name');
  });

  it('leaves modules alone that never import a sink package', () => {
    expect(collectRouteReferences('export const route = (name) => name;\nroute(`x.${y}`);\n', 'x.ts')).toEqual({ references: [], problems: [] });
  });
});
