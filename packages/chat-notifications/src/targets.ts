import { checkSinkAddress, checkWebhook, describeDestination, hostPatternProblem, NAME, pathPrefixProblem } from './destination.ts';
import type { ChatDriver, ChatDriverContext, ChatDriverFactory, ChatJson } from './driver.ts';
import { BUILT_IN_DRIVERS } from './drivers/index.ts';
import { ChatDriverError, ChatError } from './errors.ts';
import { checkedJson, type ChatContent, type ChatDestination } from './message.ts';

/** Where one message goes: the address, the driver that formats it, and whether anything is sent (`CHAT_DRIVER=log` sends nothing). */
export interface Target {
  readonly label: string;
  readonly url: string;
  readonly driverName: string;
  /** `undefined` only for the `log` sink with no driver of its own. */
  readonly driver: ChatDriver | undefined;
  /** `CHAT_DRIVER=log`: the message is logged and never sent, whatever driver the destination names. */
  readonly sink: boolean;
}

/** What a driver rendered: the JSON body (a checked copy) and the query parameters it adds to the address. */
export interface Rendered {
  readonly json: ChatJson;
  readonly search: readonly (readonly [string, string])[];
}

/** The strings of a list a driver declared, copied element by element; `undefined` when it is no list, is empty or holds a non-string. */
function strings(list: unknown): string[] | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const copy: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item: unknown = list[index];
    if (typeof item !== 'string') return undefined;
    copy.push(item);
  }
  return copy;
}

/**
 * Reads what `built` declares exactly once (`render`, `hosts`, `paths`: a getter cannot answer differently to the check and to the
 * guard), checks that copy and returns a driver made of it with its lists frozen; or why it is no chat driver. A driver is an object
 * with a `render` function, `hosts` a non-empty list of host patterns and `paths` a non-empty list of path prefixes, each of which
 * the guard accepts. The problem names the entry, never a webhook address, and ends in a period.
 * @internal
 */
export function readDriver(built: unknown): { readonly driver: ChatDriver } | { readonly problem: string } {
  if (typeof built !== 'object' || built === null) return { problem: 'it returned no object.' };
  const { render, hosts: declaredHosts, paths: declaredPaths } = built as { render?: unknown; hosts?: unknown; paths?: unknown };
  if (typeof render !== 'function') return { problem: 'it has no render(content, raw) function.' };
  const hosts = strings(declaredHosts);
  if (hosts === undefined) return { problem: '`hosts` must be a non-empty list of host names such as "chat.example.com" or "*.example.com".' };
  for (const [index, host] of hosts.entries()) {
    const problem = hostPatternProblem(host);
    if (problem !== undefined) return { problem: `\`hosts[${index}]\` is refused: ${problem}` };
  }
  const paths = strings(declaredPaths);
  if (paths === undefined) return { problem: '`paths` must be a non-empty list of path prefixes such as "/hooks/".' };
  for (const [index, prefix] of paths.entries()) {
    const problem = pathPrefixProblem(prefix);
    if (problem !== undefined) return { problem: `\`paths[${index}]\` is refused: ${problem}` };
  }
  return {
    driver: Object.freeze({
      hosts: Object.freeze(hosts),
      paths: Object.freeze(paths),
      render: (content: ChatContent, raw: unknown) => (render as ChatDriver['render']).call(built, content, raw),
    }),
  };
}

/**
 * Renders `content` with `driver` (named `name`) and checks what comes back as the neutral message was checked: a driver of
 * JavaScript, or one that returns what its types forbid, never puts anything but JSON on the wire. A driver that throws something
 * other than `ChatError` is a driver that is broken; its error is the `cause`.
 * @internal
 */
export function renderFor(driver: ChatDriver, name: string, content: ChatContent): Rendered {
  let request: unknown;
  try {
    // an own key only: `constructor` is a driver name too
    const raw = content.raw !== undefined && Object.hasOwn(content.raw, name) ? content.raw[name] : undefined;
    request = driver.render(content, raw);
  } catch (error) {
    if (error instanceof ChatError) throw error;
    throw new ChatDriverError(`The chat driver "${name}" failed to render the message.`, { cause: error });
  }
  try {
    if (typeof request !== 'object' || request === null) throw new ChatError(`The chat driver "${name}" returned no request: render() returns { json, search? }.`);
    const { json, search } = request as { json?: unknown; search?: unknown };
    const body = checkedJson(json, name);
    const entries: (readonly [string, string])[] = [];
    if (search !== undefined) {
      if (typeof search !== 'object' || search === null || Array.isArray(search)) throw new ChatError(`The chat driver "${name}" returned a request whose search is not an object of strings.`);
      for (const [key, value] of Object.entries(search)) {
        if (typeof value !== 'string') throw new ChatError(`The chat driver "${name}" returned a request whose search is not an object of strings.`);
        entries.push([key, value]);
      }
    }
    return { json: body, search: entries };
  } catch (error) {
    // a getter or a proxy of the request that throws; its error stays out (it may hold data)
    if (error instanceof ChatError) throw error;
    throw new ChatError(`The chat driver "${name}" returned a request that could not be read.`);
  }
}

/**
 * Why the address of `target` is refused: its driver's rule, or the basic rule of the sink; `undefined` when it passes.
 * @internal
 */
export function addressProblem(target: Target): string | undefined {
  if (target.driver === undefined) {
    const result = checkSinkAddress(target.url);
    return result.ok ? undefined : result.problem;
  }
  const result = checkWebhook(target.url, target.driver, target.driverName);
  return result.ok ? undefined : result.problem;
}

export interface TargetsOptions {
  /** `CHAT_DRIVER`. */
  readonly driver: string;
  /** The named destinations, from `CHAT_WEBHOOKS`. */
  readonly webhooks: ReadonlyMap<string, string>;
  /** The drivers other providers bring. */
  readonly custom: () => ReadonlyMap<string, ChatDriverFactory>;
  readonly context: (name: string) => ChatDriverContext;
}

/**
 * Where a destination points and with which driver. Every driver lookup goes through a `Map`: `constructor` is a legal name.
 * @internal
 */
export class ChatTargets {
  readonly #options: TargetsOptions;
  readonly #drivers = new Map<string, ChatDriver>(Object.entries(BUILT_IN_DRIVERS));

  constructor(options: TargetsOptions) {
    this.#options = options;
  }

  /** Every driver name a message can name in `raw` or `to.driver`: the built-in ones and those other providers bring. */
  names(): readonly string[] {
    return [...new Set([...Object.keys(BUILT_IN_DRIVERS), ...this.#options.custom().keys()])];
  }

  /** The driver registered under `name`, built once and checked when it comes from a provider (a build that failed is tried again by the next call); a name nobody brought is a `ChatError`. */
  driver(name: string): ChatDriver {
    const known = this.#drivers.get(name);
    if (known !== undefined) return known;
    const factory = NAME.test(name) ? this.#options.custom().get(name) : undefined;
    if (factory === undefined) {
      throw new ChatError(`The chat driver ${NAME.test(name) ? `"${name}" ` : ''}is not known. Known: ${this.names().join(', ')}.`);
    }
    let built: unknown;
    try {
      built = factory(this.#options.context(name));
    } catch (error) {
      throw new ChatDriverError(`The chat driver "${name}" could not be built.`, { cause: error });
    }
    // a getter or a proxy that throws is a driver that breaks its contract, like a factory that throws; its error stays out (it may hold data)
    let read: ReturnType<typeof readDriver>;
    try {
      read = readDriver(built);
    } catch {
      read = { problem: 'reading it failed.' };
    }
    if ('problem' in read) throw new ChatError(`The chat driver "${name}" must return a ChatDriver: ${read.problem}`);
    const { driver } = read;
    this.#drivers.set(name, driver);
    return driver;
  }

  /** Where `to` points. Throws `ChatError` for a named destination `CHAT_WEBHOOKS` does not list and for a driver nobody brought. */
  resolve(to: ChatDestination): Target {
    const label = describeDestination(to);
    const sink = this.#options.driver === 'log';
    let url: string | undefined;
    let driverName = this.#options.driver;
    let explicit = false;
    if (typeof to === 'string') {
      url = this.#options.webhooks.get(to);
      if (url === undefined) {
        const names = [...this.#options.webhooks.keys()];
        throw new ChatError(`No ${label} — CHAT_WEBHOOKS names ${names.length === 0 ? 'none' : names.join(', ')}.`);
      }
    } else {
      url = to.url;
      if (to.driver !== undefined) {
        driverName = to.driver;
        explicit = true;
      }
    }
    // `log` is a sink, not a driver: it is only a name here when nothing else was named
    if (sink && !explicit) return { label, url, driverName, driver: undefined, sink };
    return { label, url, driverName, driver: this.driver(driverName), sink };
  }

  /** Why `to` is refused, or `undefined`: an unknown destination or driver, or an address its driver's rule does not accept. */
  problem(to: ChatDestination): string | undefined {
    let target: Target;
    try {
      target = this.resolve(to);
    } catch (error) {
      if (error instanceof ChatError) return error.message;
      throw error;
    }
    return addressProblem(target);
  }

  /**
   * Checks a message where it is written: `raw` names only drivers there are, and the driver of the destination renders the
   * message (a raw format it refuses, or a request that is not JSON, throws `ChatError` here, not as a failed job).
   */
  validate(to: ChatDestination, content: ChatContent): void {
    const target = this.resolve(to);
    if (content.raw !== undefined) {
      const names = new Set(this.names());
      for (const key of Object.keys(content.raw)) {
        if (!names.has(key)) {
          throw new ChatError(`Chat message: ${NAME.test(key) ? `"raw.${key}"` : 'a key of "raw"'} names no chat driver. Known: ${[...names].join(', ')}.`);
        }
      }
    }
    if (target.driver !== undefined) renderFor(target.driver, target.driverName, content);
  }
}
