import { escapesRoot } from '@marmeon/core/internal';
import type { CommandInput } from './command.ts';

/**
 * Says so and returns `true` when writing any of `files` would go through a link out of the project (a cloned repository can
 * carry one): the caller writes nothing then. Checked for all files before the first write.
 */
export function leavesProject(input: Pick<CommandInput, 'root' | 'output'>, files: readonly string[]): boolean {
  for (const file of files) {
    const link = escapesRoot(input.root, file);
    if (link === undefined) continue;
    input.output.error(`${link.split(/[\\/]/).join('/')} leads out of the project, and the command would write through it. Replace the link with a real file or directory. Nothing was written.`);
    return true;
  }
  return false;
}
