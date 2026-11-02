// Type guarantees of `<Island href>` — checked by `tsc` (pnpm build / typecheck), never run.
import { Island } from './island.tsx';

export function Panels({ url }: { url: string }) {
  return (
    <>
      <Island href={url} fallback={<p>…</p>} load="visible" pollMs={15_000} />
      <Island href="/dashboard/islands/members?limit=3" unauthorized={<p>Administrators only.</p>} />
      {/* An href and a route name are two ways to say the same thing: Type 'string' is not assignable to type 'undefined'. */}
      {/* @ts-expect-error */}
      <Island href={url} route="dashboard.members" />
      {/* The query is part of the href: Type '{ limit: number; }' is not assignable to type 'undefined'. */}
      {/* @ts-expect-error */}
      <Island href={url} query={{ limit: 3 }} />
      {/* @ts-expect-error */}
      <Island href={url} params={{ user: 1 }} />
      {/* Neither a route nor an href. */}
      {/* @ts-expect-error */}
      <Island fallback={<p>…</p>} />
      {/* @ts-expect-error */}
      <Island href={3} />
    </>
  );
}
