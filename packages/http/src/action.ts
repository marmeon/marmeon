/**
 * Types of actions (E59) — non-navigating requests by route name (`useAction` of @marmeon/react): what an action sends
 * (its controller's request schema) and what it gets back (its controller's answer). Types only: erased, so the browser
 * bundle stays free of server code.
 */
import type { BrowserRouteName, CheckBrowserRouteName, ControllerOf, FormOf, IslandRouteName, MethodOf, ParamsOf, QueryParams, Routes } from '@marmeon/router';
import type { JsonResult } from './json.ts';
import type { RedirectResult } from './redirect.ts';
import type { Serialize, ViewResult } from './view.ts';

type Registered = [keyof Routes] extends [never] ? false : true;

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

/** What the controller of route `N` answers (awaited, every branch) — `unknown` for a closure. */
export type ActionAnswerOf<N extends string> = [ControllerOf<N>] extends [never]
  ? unknown
  : Instance<ControllerOf<N>> extends { handle: (...args: never[]) => infer R }
    ? Awaited<R>
    : unknown;

/** The data of one branch of a controller's answer, as it arrives (`Serialize`) — `never` for a branch without data. */
type DataOf<R> = R extends JsonResult<infer T>
  ? Serialize<T>
  : R extends RedirectResult
    ? never
    : R extends ViewResult
      ? never // a page (or a layer) — not an action's answer: the server refuses it (406)
      : R extends { readonly region: 'island' }
        ? never
        : R extends Response
          ? unknown
          : R extends undefined | null | void
            ? undefined
            : Serialize<R>;

/**
 * What a successful action of route `N` brings back: `Serialize<T>` of its controller's `this.json(data)` (or of plain data it
 * returns) — a union when it answers differently in different branches. `never` when it only redirects.
 */
export type ActionDataOf<N extends string> = DataOf<ActionAnswerOf<N>>;

/** Whether the controller of route `N` may answer with a redirect — the action then ends `{ kind: 'redirect' }` (not followed). */
export type ActionRedirects<N extends string> = unknown extends ActionAnswerOf<N> ? true : [Extract<ActionAnswerOf<N>, RedirectResult>] extends [never] ? false : true;

/**
 * The body an action of route `N` sends: its controller's request schema input (`FormOf`) — `never` without a schema (and for a
 * GET); any fields for a name the app's routes do not have (no routes generated, a package's own tests).
 */
export type ActionBodyOf<N extends string> = N extends keyof Routes ? (MethodOf<N> extends 'get' ? never : FormOf<Instance<ControllerOf<N>>>) : Record<string, unknown>;

/** The query an action of route `N` may carry — typed by its query schema (a GET action). */
export type ActionQueryOf<N extends string> = QueryParams<N>;

/** The path parameters of route `N`. */
export type ActionParamsOf<N extends string> = ParamsOf<N>;

/**
 * `N` when an action may call it (E59): a route the browser may know that answers with data or a redirect; otherwise a
 * message — an island, a page (its controller only returns `this.view(…)`), anything else as {@link CheckBrowserRouteName}.
 */
export type CheckActionRouteName<N extends string> = string extends N
  ? BrowserRouteName
  : Registered extends false
    ? N
    : CheckBrowserRouteName<N> extends N
      ? N extends IslandRouteName
        ? `'${N}' is an island — embed it with <Island route="${N}">; an action calls a route that answers this.json(…) or a redirect`
        : [ActionDataOf<N>] extends [never]
          ? ActionRedirects<N> extends true
            ? N
            : `'${N}' answers with a page — visit it (<Link>, useForm); an action's controller returns this.json(…) or a redirect`
          : N
      : CheckBrowserRouteName<N>;
