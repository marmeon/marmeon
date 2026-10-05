/**
 * The format of a step's Gegenproben (E188, Wave 9): one file per step under `scripts/gegen/<wave>/sNN-<topic>.ts`, its default export
 * `defineGegenproben({ step, cases })`, run by `pnpm gegen` (`scripts/gegen/run.ts`). A Gegenprobe takes a measure out (a patch) and
 * proves a test turns red — for the reason the measure is there (the failure's message, not just "red"). See CONTRIBUTING.md,
 * "Gegenproben".
 */

/** One replacement in one file. `find` must occur exactly once in the file (after the case's earlier patches of it). */
export interface GegenPatch {
  /** Relative to the repository's root; `dist/` files too (patch them after `pnpm build` — what `pack:smoke` packs). */
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

interface RunOptions {
  /** Extra environment for the run. */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the run is stopped (default 10 minutes). */
  readonly timeout?: number;
}

/**
 * Vitest through the repository's `pnpm test`: the files, and a test name — plain text, the runner escapes it for `-t`. Vitest 5 matches
 * it against the full name, the describes joined with ` > ` (`'its budget (E75: a ratchet) > core'`); a part of it is enough.
 */
export interface VitestRun extends RunOptions {
  readonly vitest: string | readonly string[];
  readonly name?: string;
}

/** Any command, in the repository's root: exit 0 is green; the reason is its output. */
export interface CommandRun extends RunOptions {
  readonly command: readonly [string, ...string[]];
}

export interface GegenCase {
  /** Unique in its step, e.g. `G3` or `G3b`. */
  readonly id: string;
  readonly title: string;
  /** The measure taken out: every patch of the case or none (anchors are checked first). */
  readonly patch: readonly GegenPatch[];
  readonly run: VitestRun | CommandRun;
  /** The reason: matched against the failures' messages (Vitest) or the command's output. Required unless `expectGreen`. */
  readonly expect?: RegExp;
  /**
   * The case this one forms a masking pair with: two measures that can hide each other, each taken out in a scenario of its own —
   * both cases must be red on their own.
   */
  readonly masks?: string;
  /** A masking probe: with the patch the run must stay GREEN (the other measure covers it). Counted apart from the red cases. */
  readonly expectGreen?: boolean;
}

export interface Gegenproben {
  /** The step, e.g. `W9.1`. */
  readonly step: string;
  readonly cases: readonly GegenCase[];
}

/** Checks a step's Gegenproben when the file is loaded: unique ids, a reason for every red case, pairs that exist, patches inside the repository. */
export function defineGegenproben(definition: Gegenproben): Gegenproben {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const entry of definition.cases) {
    if (ids.has(entry.id)) problems.push(`${entry.id}: the id is used twice`);
    ids.add(entry.id);
    if (!entry.expectGreen && !entry.expect) problems.push(`${entry.id}: a case that must turn red needs \`expect\` (its reason)`);
    if (entry.expectGreen && entry.expect) problems.push(`${entry.id}: a masking probe (\`expectGreen\`) has no reason to expect`);
    if (entry.patch.length === 0) problems.push(`${entry.id}: no patch — a Gegenprobe takes a measure out`);
    for (const patch of entry.patch) {
      if (patch.file.startsWith('/') || patch.file.split(/[\\/]/).includes('..')) problems.push(`${entry.id}: ${patch.file} is not inside the repository`);
      if (patch.find === '') problems.push(`${entry.id}: an empty anchor in ${patch.file}`);
    }
    if ('vitest' in entry.run && entry.run.name === '') problems.push(`${entry.id}: an empty test name`);
  }
  for (const entry of definition.cases) {
    if (entry.masks !== undefined && !ids.has(entry.masks)) problems.push(`${entry.id}: masks ${entry.masks}, which is not a case of ${definition.step}`);
  }
  if (problems.length > 0) throw new Error(`Gegenproben of ${definition.step}:\n  ${problems.join('\n  ')}`);
  return definition;
}
