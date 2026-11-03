import { LAST_ERROR_TOOL } from './last-error.ts';
import { ROUTES_TOOL } from './routes.ts';
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
  /** Whether the tool starts a child process (those run one at a time). */
  readonly spawns: boolean;
  /** `input` has been checked against `inputSchema` already. */
  run(input: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolDocument | ToolFailure>;
}

/** The tools the server offers. All of them only read. */
export const TOOLS: readonly McpTool[] = [ROUTES_TOOL, LAST_ERROR_TOOL];
