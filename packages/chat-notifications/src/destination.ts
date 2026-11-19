import type { ChatDriver } from './driver.ts';
import type { ChatDestination } from './message.ts';

/** The grammar of a destination name and of a driver name. */
export const NAME = /^[a-z][a-z0-9-]*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENCODED_SEPARATOR = /%2f|%5c/i;

declare const checked: unique symbol;

/** A webhook address that passed the guard, normalized: only `checkWebhook` creates one. */
export type WebhookHref = string & { readonly [checked]: true };

/** The verdict on a webhook address: its normalized `href`, or why it is refused (never containing the path or the query). */
export type WebhookCheck = { readonly ok: true; readonly href: WebhookHref } | { readonly ok: false; readonly problem: string };

function refuse(problem: string): WebhookCheck {
  return { ok: false, problem };
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The host as the guard compares it: lower case (the parser did that), without one trailing dot. */
function hostOf(url: URL): string {
  return url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host);
}

function matchesHost(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  return host.length > suffix.length && host.endsWith(suffix);
}

/** Scheme, credentials and port: what every webhook address must satisfy. */
function basics(url: string): { readonly parsed: URL } | { readonly problem: string } {
  const parsed = typeof url === 'string' ? parse(url) : undefined;
  if (parsed === undefined) return { problem: 'The webhook address is not an address.' };
  if (parsed.protocol !== 'https:') return { problem: 'The webhook address must use https.' };
  if (parsed.username !== '' || parsed.password !== '') return { problem: 'The webhook address must not carry credentials.' };
  if (parsed.port !== '') return { problem: 'The webhook address must not use a port other than 443.' };
  return { parsed };
}

function normalized(parsed: URL): WebhookHref {
  const copy = new URL(parsed.href);
  copy.hostname = hostOf(parsed);
  return copy.href as WebhookHref;
}

/**
 * The one guard for a webhook address of a driver. Fails closed: an address with credentials, a port other than 443, a scheme
 * other than https, an IP literal, an encoded `/` or `\` in the path, or a host and path the rule does not list is refused, as
 * is a missing rule. On success it returns the parsed address (lower-case host, no trailing dot, no explicit port). A refusal
 * names the host, never the path or the query: both hold the secret of the webhook.
 * @internal
 */
export function checkWebhook(url: string, rule: Pick<ChatDriver, 'hosts' | 'paths'>, driverName?: string): WebhookCheck {
  if (!rule || !Array.isArray(rule.hosts) || !Array.isArray(rule.paths)) return refuse('The webhook address has no driver rule to be checked against.');
  const result = basics(url);
  if ('problem' in result) return refuse(result.problem);
  const { parsed } = result;
  const host = hostOf(parsed);
  const of = driverName === undefined ? 'the driver' : `driver "${driverName}"`;
  if (isIpLiteral(host) || !rule.hosts.some((pattern) => matchesHost(host, pattern))) {
    return refuse(`The webhook host "${host}" is not one of the hosts of ${of} (${rule.hosts.join(', ')}).`);
  }
  if (!rule.paths.some((prefix) => parsed.pathname.startsWith(prefix)) || ENCODED_SEPARATOR.test(parsed.pathname)) {
    return refuse(`The webhook address on "${host}" is not a webhook address of ${of}.`);
  }
  return { ok: true, href: normalized(parsed) };
}

/**
 * The guard for the `log` sink, which has no host list: https, no credentials, port 443 and no IP literal. It does not look at
 * what a name resolves to, and it returns no address: the sink never connects.
 * @internal
 */
export function checkSinkAddress(url: string): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  const result = basics(url);
  if ('problem' in result) return { ok: false, problem: result.problem };
  if (isIpLiteral(hostOf(result.parsed))) return { ok: false, problem: 'The webhook address must not be an IP address.' };
  return { ok: true };
}

/**
 * Why a host pattern of a driver is refused, or `undefined`: a lower-case DNS name of at least two labels (the last one not
 * numeric, labels of 1 to 63 characters, at most 253 in all), or `*.` followed by such a name. No IP address, no port, no
 * other `*`.
 * @internal
 */
export function hostPatternProblem(pattern: string): string | undefined {
  const name = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  const labels = name.split('.');
  if (name.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label)) || /^\d+$/.test(labels.at(-1) ?? '')) {
    return 'A host pattern is a lower-case DNS name of at least two labels, or `*.` and such a name.';
  }
  return undefined;
}

/**
 * Why a path prefix of a driver is refused, or `undefined`: it starts and ends with `/`, has at least one segment, no empty
 * segment, no `.` or `..` segment, and only the characters a URL path keeps as written (`A-Z a-z 0-9 . _ ~ ! $ & ' ( ) * + , ; = : @ -`),
 * so a prefix the parser would rewrite, and that could never match, is refused.
 * @internal
 */
export function pathPrefixProblem(prefix: string): string | undefined {
  const segments = prefix.slice(1, -1).split('/');
  if (
    prefix.length < 3 ||
    !prefix.startsWith('/') ||
    !prefix.endsWith('/') ||
    !/^[/A-Za-z0-9._~!$&'()*+,;=:@-]+$/.test(prefix) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return 'A path prefix starts and ends with `/`, has at least one segment, and has no empty, `.` or `..` segment, and only characters that a URL path keeps as written.';
  }
  return undefined;
}

/**
 * How a destination appears in a message or a log: the name of a named destination, or the host of a webhook address. Never
 * the address, and never a string that is not a name (it could be an address).
 * @internal
 */
export function describeDestination(to: ChatDestination): string {
  if (typeof to === 'string') return NAME.test(to) ? `destination "${to}"` : 'a destination that is not a valid name';
  const parsed = parse(to.url);
  return parsed === undefined ? 'a webhook address that is not a URL' : `a webhook on ${hostOf(parsed)}`;
}
