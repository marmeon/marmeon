import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../../../packages/cli/src/mcp/tools.ts';
import { Terminal } from './components/Terminal.tsx';
import { AGENT_SKILLS, AGENT_TOOLS, AGENTS_INSTALL_COMMAND, AGENTS_INSTALL_OUTPUT } from './agents.ts';

const cli = resolve(import.meta.dirname, '../../../../packages/cli');

/** The element of `type` named `name` anywhere in a tree of elements. */
function find(node: ReactNode, name: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child as ReactNode, name)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function' && element.type.name === name) return element;
  return find(element.props.children as ReactNode, name);
}

describe('the landing\'s Agents section tells the truth about the CLI', () => {
  it('shows exactly the skills the CLI ships', () => {
    const shipped = readdirSync(join(cli, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(cli, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
    expect(AGENT_SKILLS.map(({ name }) => name).sort()).toEqual(shipped);
  });

  it('shows exactly the tools of the MCP server, in its order', () => {
    expect(AGENT_TOOLS.map(({ name }) => name)).toEqual(TOOLS.map(({ name }) => name));
  });

  it('prints the lines docs/agents.md shows, which a test of the CLI holds to the command', () => {
    const docs = readFileSync(join(cli, '../../docs/agents.md'), 'utf8');
    expect(docs).toContain(`\`\`\`sh\n${AGENTS_INSTALL_COMMAND}\n\`\`\`\n\n\`\`\`txt\n${AGENTS_INSTALL_OUTPUT.join('\n')}\n\`\`\``);
  });
});

describe('Terminal output lines', () => {
  it('are drawn without a prompt and are not copied', () => {
    const tree = Terminal({ commands: [AGENTS_INSTALL_COMMAND], output: AGENTS_INSTALL_OUTPUT });
    expect(find(tree, 'CopyButton')?.props.text).toBe(AGENTS_INSTALL_COMMAND);
  });

  it('are optional: a call without them draws none', () => {
    const tree = Terminal({ commands: ['pnpm dev'] });
    expect(find(tree, 'CopyButton')?.props.text).toBe('pnpm dev');
  });
});
