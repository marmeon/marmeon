import type { Navigator } from '@marmeon/http/client';
import { scriptJson, type DeferredResult, type RegionResult } from '@marmeon/http/page';
import { createContext, Suspense, use, useContext, useEffect, useId, useState } from 'react';

/**
 * Server rendering only: what the page's request resolves in-process while the page streams — each island and each
 * deferred group once per render (two identical islands share one), per request. The browser has none: there, islands and
 * deferred groups that did not come with the document load themselves.
 */
export interface SsrResolvers {
  island(url: string): Promise<RegionResult>;
  deferred(group: string): Promise<DeferredResult | null>;
}

export const SsrContext = createContext<SsrResolvers | null>(null);

/** The resolvers of one render: `resolveIsland`/`resolveDeferred` of the adapter contract, each URL or group asked once. */
export function ssrResolvers(
  resolveIsland: ((url: string) => Promise<RegionResult>) | undefined,
  resolveDeferred: ((group: string) => Promise<DeferredResult | null>) | undefined,
): SsrResolvers {
  const islands = new Map<string, Promise<RegionResult>>();
  const groups = new Map<string, Promise<DeferredResult | null>>();
  return {
    island(url) {
      let result = islands.get(url);
      if (!result) {
        // Without a resolver (an SSR entry used without the server's), the browser loads the island.
        result = resolveIsland
          ? resolveIsland(url).catch((): RegionResult => ({ status: 'exception', failure: {} }))
          : Promise.resolve<RegionResult>({ status: 'browser' });
        islands.set(url, result);
      }
      return result;
    },
    deferred(group) {
      let result = groups.get(group);
      if (!result) {
        result = resolveDeferred ? resolveDeferred(group).catch(() => null) : Promise.resolve(null);
        groups.set(group, result);
      }
      return result;
    },
  };
}

/**
 * The JSON the server streamed into a `<script type="application/json">` — read once, while hydrating: what the browser
 * renders must be what the server did. `undefined` when there is none (the part was rendered in the browser).
 */
export function streamedText(id: string): string | undefined {
  // Only script elements are looked at (by `id` or `name`), and sanitised user HTML cannot contain any.
  return globalThis.document?.scripts.namedItem(id)?.textContent || undefined;
}

/** The parsed `text` of {@link streamedText} — `null` for none, or for what is not JSON. */
export function streamedJson<T>(text: string | undefined): T | null {
  try {
    return JSON.parse(text ?? 'null') as T | null;
  } catch {
    return null;
  }
}

/**
 * An inert data block in the document — `<script type="application/json">`, never executed, so a strict
 * Content-Security-Policy needs no nonce for it. The JSON comes from `scriptJson` (`<` escaped: it can never end the
 * element) — or is the text such a block already had.
 */
export function DataScript({ id, json }: { id: string; json: string }) {
  return <script type="application/json" id={id} dangerouslySetInnerHTML={{ __html: json }} />;
}

/**
 * The deferred groups the server streams with the document (`streamedProps`) — one Suspense boundary each, at the
 * end of the page: on the server it waits for the group (computed once the headers are out) and renders its props as a
 * data block; in the browser it hands them to the navigator as the boundary hydrates — no request. A group that did not
 * come (it failed, or its part was rendered in the browser) is asked for as without streaming.
 */
export function StreamedDeferred({ groups, navigator }: { groups: readonly string[] | undefined; navigator: () => Navigator | null }) {
  if (!groups || groups.length === 0) return null;
  // Inside an element on purpose: a Suspense boundary at the top of the tree could still bring `<html>`/`<head>` (React's
  // preamble) — React would hold the whole shell back until it is done.
  return (
    <div hidden data-marmeon-streamed="">
      {groups.map((group) => (
        <Suspense key={group} fallback={null}>
          <StreamedGroup group={group} navigator={navigator} />
        </Suspense>
      ))}
    </div>
  );
}

function StreamedGroup({ group, navigator }: { group: string; navigator: () => Navigator | null }) {
  const ssr = useContext(SsrContext);
  const id = `marmeon-deferred-${useId()}`;
  if (ssr) return <ServerGroup id={id} result={ssr.deferred(group)} />;
  return <BrowserGroup id={id} group={group} navigator={navigator} />;
}

function ServerGroup({ id, result }: { id: string; result: Promise<DeferredResult | null> }) {
  return <DataScript id={id} json={scriptJson(use(result))} />;
}

function BrowserGroup({ id, group, navigator }: { id: string; group: string; navigator: () => Navigator | null }) {
  const [text] = useState(() => streamedText(id));
  useEffect(() => {
    void navigator()?.receiveStreamed(group, streamedJson<DeferredResult>(text));
  }, [group, navigator, text]);
  return <DataScript id={id} json={text ?? 'null'} />;
}
