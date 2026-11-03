import { isDeepStrictEqual } from 'node:util';
import { err, ok, type Result } from '@marmeon/core';

/** The entry `marmeon` in `.mcp.json`. The path is relative to the app's root, where agents start servers; no `npx`, which could download. */
export const MCP_ENTRY = { command: 'node', args: ['node_modules/marmeon/bin/marmeon.js', 'mcp'] } as const;

/** What happens to `.mcp.json`: it is made, the entry is added or replaced, or it is current. */
export type McpChange = 'create' | 'update' | 'unchanged';

/** The file is not one the program rewrites; nothing is written. */
export interface McpJsonError {
  readonly kind: 'mcp-json';
  readonly message: string;
}

export interface McpMerge {
  readonly text: string;
  readonly change: McpChange;
  /** An entry `marmeon` that differed was put in its place. */
  readonly replaced: boolean;
}

/** The mark the file shows: the entry of `marmeon` is there, whatever it holds. */
export function hasMcpEntry(text: string): boolean {
  try {
    const root: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return isObject(root) && Object.hasOwn(root, 'mcpServers') && isObject(root.mcpServers) && Object.hasOwn(root.mcpServers, 'marmeon');
  } catch {
    return false;
  }
}

/**
 * Puts the entry `marmeon` into the text of a `.mcp.json`, or makes the text. Only `mcpServers.marmeon` is set or replaced; every
 * other entry and key stays, in its order. The file is read again, so it keeps the indentation (the first indented line decides),
 * the line end and a byte order mark. Text that is not JSON, a root that is no object or an `mcpServers` that is no object is an
 * error: the program never repairs a file it does not understand. `unchanged` leaves the text alone, whatever its formatting.
 * See docs/agents.md#skills-and-the-mcp-server.
 */
export function mergeMcpJson(whole: string | undefined): Result<McpMerge, McpJsonError> {
  const entry = { command: MCP_ENTRY.command, args: [...MCP_ENTRY.args] };
  if (whole === undefined) return ok({ text: `${JSON.stringify({ mcpServers: { marmeon: entry } }, null, 2)}\n`, change: 'create', replaced: false });
  const bom = whole.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = whole.slice(bom.length);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return fail(`.mcp.json is not valid JSON (${(error as Error).message}). Fix it or remove it, then run marmeon agents:install again. Nothing was written.`);
  }
  if (!isObject(root)) return fail('.mcp.json is not a JSON object. Nothing was written.');
  if (Object.hasOwn(root, 'mcpServers') && !isObject(root.mcpServers)) return fail('"mcpServers" in .mcp.json is not an object. Nothing was written.');

  const servers = Object.hasOwn(root, 'mcpServers') ? (root.mcpServers as Record<string, unknown>) : undefined;
  const existing = servers !== undefined && Object.hasOwn(servers, 'marmeon');
  if (existing && isDeepStrictEqual(servers['marmeon'], entry)) return ok({ text: whole, change: 'unchanged', replaced: false });

  // The parsed object is changed in place. Its keys must never be copied onto a new object with [[Set]] (`Object.assign`, or
  // `target[key] = value` in a loop): a key `__proto__` that the file holds would set the prototype and drop out of the output.
  if (servers) servers['marmeon'] = entry;
  else root['mcpServers'] = { marmeon: entry };

  const indent = /^([ \t]+)\S/m.exec(text)?.[1]?.slice(0, 10) ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return ok({ text: bom + JSON.stringify(root, null, indent).replaceAll('\n', eol) + eol, change: 'update', replaced: existing });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string) {
  return err({ kind: 'mcp-json' as const, message });
}
