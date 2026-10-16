const warned = new Set<string>();

/**
 * Warns once per `id` that a deprecated API was used — only when `NODE_ENV` is `development` or `test`, never in production.
 * Give `id` as `<package>.<name>` (`http.sensitive-remember-field`), name the replacement in `message`, and `removeIn` as the
 * major or minor that removes the API. See docs/package-development.md#deprecating-an-api.
 */
export function deprecated(id: string, message: string, removeIn: `${number}.${number}`): void {
  // Inline, so a bundler that replaces `process.env.NODE_ENV` drops the rest from a production client build.
  if (!(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) return;
  if (warned.has(id)) return;
  warned.add(id);
  const text = `[marmeon] ${message} It is removed in ${removeIn}.`;
  // The browser has no `process.emitWarning`; Node's gives `--no-deprecation` and `--throw-deprecation` their say.
  if (typeof globalThis.process?.emitWarning === 'function') globalThis.process.emitWarning(text, { type: 'DeprecationWarning', code: id });
  else console.warn(text);
}
