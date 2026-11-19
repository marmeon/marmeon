import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainReason, type CheckRun } from './tools.ts';
import { reportOf, unrunReport, type CheckProblem } from './report.ts';

const DOCS = 'docs/releases.md#node';
const BOUND = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
/** A version file's content: the parts it gives. */
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
/** The Node that runs: three numbers, then maybe a prerelease or build (`26.10.0-rc.1`, `27.0.0-nightly…`). */
const RUNNING = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
/** The aliases of a version file that name no version. */
const ALIAS = /^(?:lts\/(?:\*|-\d+|[a-z][a-z0-9_-]*)|node|latest|stable)$/;

/** What `nodeCheck` compares: the Node that runs, and the `engines.node` of `marmeon` (`null`: none to read). Tests give both. */
export interface NodeCheckInput {
  readonly running?: string;
  readonly marmeon?: string | null;
}

/** The `engines.node` of the running `marmeon` package, from its manifest (next to `src/` and `dist/`); undefined when it has none. */
function marmeonRange(): string | undefined {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { engines?: { node?: unknown } };
  return typeof manifest.engines?.node === 'string' ? manifest.engines.node : undefined;
}

/** Text from a file or manifest, cut for a message. */
function shown(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function parts(match: RegExpExecArray): (number | undefined)[] {
  return [1, 2, 3].map((index) => (match[index] === undefined ? undefined : Number(match[index])));
}

/**
 * Whether the Node that runs this is new enough for the app: `process.versions.node` against the `engines.node` of `marmeon` and of the
 * app's `package.json` (a single `>=X`, `>=X.Y` or `>=X.Y.Z` only), and against `.nvmrc`, else `.node-version`. Below a bound the check
 * fails. A source that cannot be judged (another form of range, an unreadable file, a version file that is no version or alias) is a
 * warning; a version file that differs is a warning too, a server may run another patch on purpose. `skipped` when there is no source.
 * See docs/check.md#the-node-check.
 */
export function nodeCheck(root: string, { running = process.versions.node, marmeon }: NodeCheckInput = {}): CheckRun {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const current = RUNNING.exec(running);
  if (!current) return { report: unrunReport('node', 'error', `the version of this Node is not readable: ${running}`, ms()) };
  const have = parts(current).map((part) => part ?? 0);
  const problems: CheckProblem[] = [];
  let sources = 0;
  const warn = (message: string) => problems.push({ severity: 'warning', message, docs: DOCS });

  const judge = (source: string, range: string) => {
    sources++;
    const match = BOUND.exec(range.trim());
    if (!match) return warn(`${source} asks for "${shown(range)}", a range this check does not judge`);
    const bound = parts(match).map((part) => part ?? 0);
    const first = [0, 1, 2].find((index) => have[index] !== bound[index]);
    if (first !== undefined && have[first]! < bound[first]!) problems.push({ severity: 'error', message: `Node ${running} runs this; ${source} needs ${shown(range.trim())}`, docs: DOCS });
  };

  try {
    const range = marmeon === undefined ? marmeonRange() : (marmeon ?? undefined);
    if (range !== undefined) judge('marmeon', range);
  } catch (error) {
    sources++;
    warn(`the engines of marmeon could not be read: ${plainReason(error, root)}`);
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines?: { node?: unknown } } | null;
    if (manifest === null || typeof manifest !== 'object') throw new Error('it holds no object');
    const range = manifest.engines?.node;
    if (range !== undefined) {
      if (typeof range === 'string') judge('package.json', range);
      else {
        sources++;
        warn('package.json holds an engines.node that is no string, which this check does not judge');
      }
    }
  } catch (error) {
    sources++;
    warn(`package.json could not be read: ${plainReason(error, root)}`);
  }
  // `.nvmrc` wins over `.node-version`: the first file that exists is the only one read.
  for (const name of ['.nvmrc', '.node-version']) {
    let text: string;
    try {
      text = readFileSync(join(root, name), 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      sources++;
      warn(`${name} could not be read: ${plainReason(error, root)}`);
      break;
    }
    const match = VERSION.exec(text);
    if (match) {
      sources++;
      const wanted = parts(match);
      if (wanted.some((part, index) => part !== undefined && part !== have[index])) warn(`Node ${running} runs this; ${name} asks for ${shown(text)}`);
    } else if (!ALIAS.test(text)) {
      sources++;
      warn(`${name} holds "${shown(text)}", which is no version or alias this check knows`);
    }
    break;
  }

  if (sources === 0) return { report: unrunReport('node', 'skipped', 'no Node version to compare with', ms()) };
  return { report: reportOf('node', problems, ms()) };
}
