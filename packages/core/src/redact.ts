/** Keys whose values never reach a log (or a stored error): passwords, tokens, secrets, credentials and cookies. */
export const REDACTED_KEYS = /pass(word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature/i;

/**
 * A copy of `context` with sensitive values replaced by `[redacted]` — by key, at any depth (`password`,
 * `new_password`, `headers.authorization`, `remember_web` …). Messages themselves are not scanned:
 * never put secrets into a log message ({@link redactText} is the safety net for text that may hold some).
 */
export function redact(context: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACTED_KEYS.test(key)) out[key] = '[redacted]';
    else if (depth < 6 && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error)) out[key] = redact(value as Record<string, unknown>, depth + 1);
    else out[key] = value;
  }
  return out;
}

// `password=…`, `token: …`, `"api_key":"…"`, `?signature=…&` — a sensitive key followed by its value.
const KEY_VALUE = /([\w-]*(?:pass(?:word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature)[\w-]*)("?\s*[:=]\s*"?)(?!\[redacted\])((?:Bearer|Basic)\s+)?([^\s"'&,;}]+)/gi;
// `Authorization: Bearer …` without the key in front (a header value on its own).
const BEARER = /\b(Bearer|Basic)\s+(?!\[redacted\])[\w.~+/=-]+/g;
// `postgres://user:secret@host`, `redis://:secret@host` — the password of a URL.
const URL_PASSWORD = /([a-z][\w+.-]*:\/\/[^:\s/@]*:)[^@\s/]+@/gi;

/**
 * Text — an error's message and stack, as stored for a failed job — with what looks like a secret replaced: values of
 * sensitive keys (`password=…`, `"token":"…"`, `?signature=…`), bearer credentials and passwords in URLs. A safety net,
 * not a guarantee: an error that quotes a secret in free text still shows it.
 */
export function redactText(text: string): string {
  return text
    .replace(URL_PASSWORD, '$1***@')
    .replace(KEY_VALUE, (_, key: string, separator: string, scheme: string | undefined) => `${key}${separator}${scheme ?? ''}[redacted]`)
    .replace(BEARER, '$1 [redacted]');
}

/**
 * An error as text for storage (a failed job's `exception`): name, message, stack and the error's own properties and
 * causes — redacted like a log entry ({@link redact} for properties, {@link redactText} for the text).
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return redactText(typeof error === 'string' ? error : safeJson(error));
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const own = Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'cause'));
    const properties = Object.keys(own).length > 0 ? `\n${safeJson(redact(own))}` : '';
    parts.push(`${depth > 0 ? 'Caused by: ' : ''}${current.stack ?? `${current.name}: ${current.message}`}${properties}`);
    current = current.cause;
  }
  if (current !== undefined && !(current instanceof Error)) parts.push(`Caused by: ${typeof current === 'string' ? current : safeJson(current)}`);
  return redactText(parts.join('\n'));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
