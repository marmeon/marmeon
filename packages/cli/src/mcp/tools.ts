import { CHECK_TOOL } from './check.ts';
import { DEVTOOLS_ENTRIES_TOOL } from './devtools.ts';
import { DOCS_READ_TOOL, DOCS_SEARCH_TOOL } from './docs.ts';
import { LAST_ERROR_TOOL } from './last-error.ts';
import { MIGRATIONS_TOOL } from './migrations.ts';
import { ROUTES_TOOL } from './routes.ts';
import { SCHEMA_TOOL } from './schema.ts';
import type { JsonSchema, ToolDocument, ToolFailure } from './result.ts';

/** What a tool is given besides its input. */
export interface ToolContext {
  /** The app's root. */
  readonly root: string;
  /** Aborts when the client cancels the call or the server ends. */
  readonly signal: AbortSignal;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** Literal JSON Schema: every object closes with `additionalProperties: false`, every string has a length. */
  readonly inputSchema: JsonSchema;
  /** Whether the tool starts a command that may write a file of the app (advertised as `readOnlyHint: false`). */
  readonly writes?: true;
  /** Whether the tool starts a child process (those run one at a time). */
  readonly spawns: boolean;
  /** Asked before the call waits in the queue: a failure refuses the call. When it answers `undefined`, `run` follows. */
  admit?(): ToolFailure | undefined;
  /** `input` has been checked against `inputSchema` already. */
  run(input: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolDocument | ToolFailure>;
}

/** The tools the server offers. The server itself writes nothing; `schema` starts a command that keeps a file up to date. */
export const TOOLS: readonly McpTool[] = [ROUTES_TOOL, LAST_ERROR_TOOL, DOCS_SEARCH_TOOL, DOCS_READ_TOOL, CHECK_TOOL, SCHEMA_TOOL, DEVTOOLS_ENTRIES_TOOL, MIGRATIONS_TOOL];
