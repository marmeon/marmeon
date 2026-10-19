import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandInput } from '../command.ts';
import { AGENTS_BLOCK } from '../agents/block.ts';
import { exists, unsafe } from '../agents/files.ts';
import { syncAgents } from '../agents/sync.ts';

/**
 * Keeps the block of `AGENTS.md` between the `marmeon:begin` and `marmeon:end` marks in step with the installed `marmeon`, and
 * makes `AGENTS.md` and `CLAUDE.md` when they are missing. Runs without booting the app: an app that does not start needs the
 * guide more. `--check` writes nothing and exits with 1 when the block is missing or out of date. See docs/agents.md#keeping-the-block-current.
 */
export class AgentsSyncCommand {
  static command = 'agents:sync';
  static description = 'Bring the managed block of AGENTS.md up to the installed version';
  static usage = '[--check]';
  static options = { check: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const agents = join(root, 'AGENTS.md');
    const claude = join(root, 'CLAUDE.md');
    // Both files are judged before anything is written, so a refusal never leaves half a run.
    const problem = unsafe(root, agents) ?? unsafe(root, claude);
    if (problem) {
      output.error(problem);
      return 1;
    }
    const hasAgents = exists(agents);
    const result = syncAgents(hasAgents ? readFileSync(agents, 'utf8') : undefined, AGENTS_BLOCK, appName(root));
    if (!result.ok) {
      output.error(result.error.message);
      return 1;
    }
    const { text, change } = result.value;

    if (options.check === true) {
      if (change === 'unchanged') {
        output.success('The block of AGENTS.md is current.');
        return 0;
      }
      output.error(change === 'replaced' ? 'The block of AGENTS.md is out of date. Run marmeon agents:sync.' : 'AGENTS.md has no block of marmeon. Run marmeon agents:sync.');
      return 1;
    }

    if (change === 'unchanged') output.success('The block of AGENTS.md is current.');
    else {
      writeFileSync(agents, text, hasAgents ? undefined : { flag: 'wx' });
      output.success({ created: 'Wrote AGENTS.md.', replaced: 'Updated the block of AGENTS.md.', appended: 'Added the block to AGENTS.md.' }[change]);
    }

    if (!exists(claude)) {
      writeFileSync(claude, '@AGENTS.md\n', { flag: 'wx' });
      output.success('Wrote CLAUDE.md.');
    } else if (!/^@AGENTS\.md\s*$/m.test(readFileSync(claude, 'utf8'))) {
      output.warn('CLAUDE.md does not import AGENTS.md; add the line "@AGENTS.md" so Claude Code reads it. The file is yours and was left as it is.');
    }
    return 0;
  }
}

/** The `name` of the app's `package.json`, for the title of a new `AGENTS.md`. */
function appName(root: string): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' && !/[\r\n]/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
