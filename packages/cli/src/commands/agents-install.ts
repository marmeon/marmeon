import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandInput } from '../command.ts';
import { unsafePath, unwritablePath, writeAtomic } from '../agents/files.ts';
import { planInstall, type InstallStep } from '../agents/install.ts';
import { shippedSkills } from '../agents/skills.ts';

/**
 * Copies the skills of the installed `marmeon` into the app (`.claude/skills/marmeon-*`, or `.agents/skills/` with `--shared`) and
 * enters the server `marmeon mcp` in `.mcp.json`; run again, it brings both up to date. It writes only the folders `marmeon-*` that
 * carry its mark and only the entry `marmeon`, refuses links and files that are not its own, and writes nothing then. `--check`
 * writes nothing and exits with 1 when something is missing or out of date. See docs/agents.md#skills-and-the-mcp-server.
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
      output.error(planned.error.message);
      return 1;
    }
    const { warnings, retired, skillsInstalled, mcpInstalled } = planned.value;
    for (const warning of warnings) output.warn(warning);
    for (const folder of retired) output.warn(`${folder} is a skill this marmeon no longer ships. It was left as it is; remove it if you do not need it.`);

    if (options.check === true) {
      // Only what is installed is judged: a skill folder or an entry that was never made is not out of date.
      const steps = planned.value.steps.filter((step) => step.kind !== 'skill' || skillsInstalled);
      if (!skillsInstalled && !mcpInstalled) {
        output.error('Not installed. Run marmeon agents:install.');
        return 1;
      }
      const stale = steps.filter((step) => step.change !== 'unchanged');
      for (const step of stale) output.error(`${step.path} is ${step.change === 'create' ? 'missing' : 'out of date'}.`);
      if (stale.length > 0) {
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
        output.error(problem);
        return 1;
      }
    }
    for (const [index, step] of changed.entries()) {
      const problem = write(root, step);
      if (problem) {
        // Only a path changed after the plan gets here; the steps before it are on disk, so the message must not say otherwise.
        const written = changed.slice(0, index);
        output.error(written.length === 0 ? problem : problem.replace(/ Nothing was written\.$/, ''));
        for (const done of written) output.warn(`${done.path} was written before the refusal.`);
        return 1;
      }
    }
    for (const step of changed) output.success(step.note ?? `${step.change === 'create' ? 'Wrote' : 'Updated'} ${step.path}.`);
    if (changed.length === 0) output.success('The skills and the entry in .mcp.json are current.');
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
