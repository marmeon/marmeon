import { relative } from 'node:path';
import { writeManifest } from '@bespokecore/core';
import type { CommandInput } from '../command.ts';

/**
 * Composer's dump-autoload + Laravel's package:discover. Also runs automatically when dependencies change. Writes the manifest of
 * this process's conditions (E160): `.bespoke/manifest.json` in an installed app, `.bespoke/manifest.source.json` in the monorepo.
 */
export class DiscoverCommand {
  static command = 'discover';
  static description = 'Discover installed packages (providers, injection lists)';
  static boots = false;

  handle({ output, root }: CommandInput): void {
    const summary = writeManifest({ root });
    for (const name of summary.packages) output.line(`  ${name}`);
    output.success(
      `${summary.packages.length} packages, ${summary.providers} providers, ${summary.injectable} injectable classes` +
        (summary.unresolvable ? `, ${summary.unresolvable} not injectable` : '') +
        ` → ${relative(root, summary.path)}`,
    );
  }
}
