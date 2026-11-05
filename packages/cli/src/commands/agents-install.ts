import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { printable } from '@marmeon/core/internal';
import type { CommandInput } from '../command.ts';
import { agentsBlock } from '../agents/block.ts';
import { exists, unsafe, unsafePath, unwritablePath, writeAtomic } from '../agents/files.ts';
import { installedTools, planInstall, type InstallStep } from '../agents/install.ts';
import { shippedSkills } from '../agents/skills.ts';
import { syncAgents } from '../agents/sync.ts';
import type { Output } from '../output.ts';

/**
 * Copies the skills of the installed `marmeon` into the app (`.claude/skills/marmeon-*`, or `.agents/skills/` with `--shared`) and
 * enters the server `marmeon mcp` in `.mcp.json`; run again, it brings both up to date. It writes only the folders `marmeon-*` that
 * carry its mark and only the entry `marmeon`, refuses links and files that are not its own, and writes nothing then. It also
 * brings the block of `AGENTS.md` up to what is installed, where the file has one. `--check` writes nothing and exits with 1 when
 * something is missing or out of date, the block included. See docs/agents.md#skills-and-the-mcp-server.
 */
export class AgentsInstallCommand {
  static command = 'agents:install';
  static description = "Install the framework's skills and register marmeon mcp for coding agents";
  static usage = '[--shared] [--no-mcp] [--check]';
  static options = { shared: { type: 'boolean' }, 'no-mcp': { type: 'boolean' }, check: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const planned = planInstall(root, shippedSkills(), { shared: options.shared === true, mcp: options['no-mcp'] !== true });
    if (!planned.ok) {
      output.error(printable(planned.error.message));
      return 1;
    }
    const { warnings, retired, skillsInstalled, mcpInstalled } = planned.value;
    for (const warning of warnings) output.warn(printable(warning));
    for (const folder of retired) output.warn(printable(`${JSON.stringify(folder)} is a skill this marmeon no longer ships. It was left as it is; remove it if you do not need it.`));

    if (options.check === true) {
      // Only what is installed is judged: a skill folder or an entry that was never made is not out of date.
      const steps = planned.value.steps.filter((step) => step.kind !== 'skill' || skillsInstalled);
      if (!skillsInstalled && !mcpInstalled) {
        output.error('Not installed. Run marmeon agents:install.');
        return 1;
      }
      const stale = steps.filter((step) => step.change !== 'unchanged');
      for (const step of stale) output.error(printable(`${step.path} is ${step.change === 'create' ? 'missing' : 'out of date'}.`));
      const blockStale = refreshBlock(root, true, output);
      if (stale.length > 0 || blockStale) {
        output.error('Run marmeon agents:install.');
        return 1;
      }
      output.success('The skills and the entry in .mcp.json are current.');
      return 0;
    }

    const changed = planned.value.steps.filter((step) => step.change !== 'unchanged');
    // Judged with the rest, before the first write, so a folder that cannot be written never leaves half a run.
    for (const step of changed) {
      const problem = unwritablePath(root, join(root, ...step.path.split('/')));
      if (problem) {
        output.error(printable(problem));
        return 1;
      }
    }
    for (const [index, step] of changed.entries()) {
      let problem: string | undefined;
      try {
        problem = write(root, step);
      } catch (error) {
        // The disk can refuse after the plan was judged (no space, a read-only file system); report it like any refusal.
        // The code only: a message of Node names the absolute path.
        const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
        problem = `${step.path} could not be written (${code}). Nothing was written.`;
      }
      if (problem) {
        // Only a path changed after the plan, or a disk that refused, gets here; the steps before it are on disk, so the message must not say otherwise.
        const written = changed.slice(0, index);
        output.error(printable(written.length === 0 ? problem : problem.replace(/ Nothing was written\.$/, '')));
        for (const done of written) output.warn(printable(`${done.path} was written before the refusal.`));
        return 1;
      }
    }
    for (const step of changed) output.success(printable(step.note ?? `${step.change === 'create' ? 'Wrote' : 'Updated'} ${step.path}.`));
    if (changed.length === 0) output.success('The skills and the entry in .mcp.json are current.');
    // Judged again from the disk, now that the files are there; never from what the plan predicted.
    refreshBlock(root, false, output);
    if (changed.some((step) => step.kind === 'mcp')) output.line('Your agent asks you to approve the server marmeon the next time it starts.');
    return 0;
  }
}

/**
 * The plan was judged as a whole before the first call, so a refusal rarely leaves half a run. The path is judged once more right
 * before it is written, in case a link appeared since: the guard sits on the side that writes.
 */
function write(root: string, step: InstallStep): string | undefined {
  const file = join(root, ...step.path.split('/'));
  const problem = unsafePath(root, file);
  if (problem) return problem;
  mkdirSync(dirname(file), { recursive: true });
  // mkdir may have followed a link made since; judge again, now that the folders exist.
  const again = unsafePath(root, file);
  if (again) return again;
  writeAtomic(file, step.text);
  return undefined;
}

const NO_BLOCK = 'AGENTS.md has no marmeon block; marmeon agents:sync writes one that names the skills and the tools.';

/**
 * Brings the block of `AGENTS.md` up to what is installed, only where the file has a block: no file is made and no block added.
 * A problem with the file is a warning, since the skills are installed anyway. With `check` nothing is written; true means the
 * block is out of date.
 */
function refreshBlock(root: string, check: boolean, output: Output): boolean {
  const file = join(root, 'AGENTS.md');
  const left = (message: string) => message.replace(/ Nothing was written\.$/, ' It was left as it is.');
  if (!exists(file)) {
    if (!check) output.line(NO_BLOCK);
    return false;
  }
  const problem = unsafe(root, file);
  if (problem) {
    output.warn(printable(left(problem)));
    return false;
  }
  const tools = installedTools(root);
  if (!tools.ok) {
    output.warn(printable(left(tools.error.message)));
    return false;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    output.warn(`AGENTS.md could not be read (${(error as NodeJS.ErrnoException).code ?? 'an unknown error'}). It was left as it is.`);
    return false;
  }
  const result = syncAgents(text, agentsBlock(tools.value));
  if (!result.ok) {
    output.warn(printable(left(result.error.message)));
    return false;
  }
  const { change, text: next } = result.value;
  if (change === 'appended') {
    if (!check) output.line(NO_BLOCK);
    return false;
  }
  if (change !== 'replaced') return false;
  if (check) {
    output.error("AGENTS.md's block is out of date.");
    return true;
  }
  // The guard sits on the side that writes: judged once more right before the write, in case a link appeared since.
  const again = unsafe(root, file);
  if (again) {
    output.warn(printable(left(again)));
    return false;
  }
  try {
    writeFileSync(file, next);
  } catch (error) {
    output.warn(`AGENTS.md could not be written (${(error as NodeJS.ErrnoException).code ?? 'an unknown error'}). It was left as it is.`);
    return false;
  }
  output.success('Updated the block of AGENTS.md.');
  return false;
}
