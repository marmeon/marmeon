/**
 * What the website's checks ask of a release line (`pnpm website:check` for the pinned ones, `pnpm website:image` for the pinned ones and a
 * fixture): its first page, that page as Markdown and the line's `llms.txt` answer 200 and tell search engines to stay away.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The first page of a snapshot (`<snapshot>/docs/index.json`, the first page of its first section). */
export function firstPageOf(snapshot: string): string {
  const index = JSON.parse(readFileSync(join(snapshot, 'docs/index.json'), 'utf8')) as { sections?: { pages?: { slug?: string }[] }[] };
  const slug = index.sections?.[0]?.pages?.[0]?.slug;
  if (typeof slug !== 'string') throw new Error(`${snapshot}/docs/index.json has no page`);
  return slug;
}

/** What is wrong with the line `line` at `base` (asks its first page `page`); [] when it is served as a line is. */
export async function lineProblems(base: string, line: string, page: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [path, accept] of [[`/docs/${line}/${page}`, 'text/html'], [`/docs/${line}/${page}.md`, '*/*'], [`/docs/${line}/llms.txt`, '*/*']] as const) {
    const response = await fetch(base + path, { headers: { accept }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    if (response.status !== 200) problems.push(`${path}: status ${response.status}, expected 200`);
    else if (accept === 'text/html' ? !/<meta name="robots" content="noindex"/.test(body) : response.headers.get('x-robots-tag') !== 'noindex') {
      problems.push(`${path}: not marked noindex (${accept === 'text/html' ? 'meta robots' : `X-Robots-Tag "${response.headers.get('x-robots-tag')}"`})`);
    }
  }
  return problems;
}
