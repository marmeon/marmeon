/**
 * `node scripts/release-notes.ts [version]` — the Markdown release notes of one version on stdout: the `## <version>` section
 * every package's `CHANGELOG.md` shares, verbatim. The version defaults to the packages' own (the lockstep version). A package
 * without the section, a section that differs between packages or an empty one is an error (exit 1): the notes would be wrong.
 *
 * The release workflow passes the output to the draft GitHub Release; it reads the working tree, which there is the release
 * commit (CONTRIBUTING.md, "Pull requests and releases").
 */
import { fileURLToPath } from 'node:url';
import { frameworkPackages } from './packages.ts';
import { releaseSection } from './release-rules.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The notes of `version`; throws when a package lacks the section, the sections differ or the section is empty. */
export function releaseNotes(repository: string, version: string): string {
  const section = releaseSection(repository, version);
  if (section === '') throw new Error(`the "## ${version}" section holds no changes`);
  return `${section}\n`;
}

if (import.meta.main) {
  try {
    const version = process.argv[2] ?? frameworkPackages(root)[0]?.manifest.version;
    if (!version) throw new Error('no version given and no package to read one from');
    process.stdout.write(releaseNotes(root, version));
  } catch (error) {
    console.error(`release-notes: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
