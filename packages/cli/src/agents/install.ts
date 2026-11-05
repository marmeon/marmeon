import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '@marmeon/core';
import type { AgentTools } from './block.ts';
import { isUnreadable, UNREADABLE, unsafePath } from './files.ts';
import { hasMcpEntry, mergeMcpJson } from './mcp-json.ts';
import { SKILL_FORMAT, skillMark } from './skills.ts';

/** The folders of skills the installer knows, relative to the app's root. */
export const SKILL_FOLDERS = { claude: '.claude/skills', shared: '.agents/skills' } as const;

/** One of the folders in `SKILL_FOLDERS`. */
export type SkillFolder = (typeof SKILL_FOLDERS)[keyof typeof SKILL_FOLDERS];

const MCP_FILE = '.mcp.json';
/** Only folders with this prefix belong to the installer; an app's own skills never collide with them. */
const PREFIX = 'marmeon-';

/** One file the install writes: where (relative to the app, with `/`), its whole new text and what would happen to it. */
export interface InstallStep {
  readonly kind: 'skill' | 'mcp';
  readonly path: string;
  readonly text: string;
  readonly change: 'create' | 'update' | 'unchanged';
  /** Something to tell the person, e.g. that an entry of the same name was replaced. */
  readonly note?: string;
}

export interface InstallPlan {
  readonly steps: readonly InstallStep[];
  /** Folders `marmeon-*` with a mark whose skill the package no longer ships. Reported, never deleted. */
  readonly retired: readonly string[];
  readonly warnings: readonly string[];
  /** Skills with a mark lie in a folder already (where an update goes). */
  readonly skillsInstalled: boolean;
  /** `.mcp.json` has an entry `marmeon`. */
  readonly mcpInstalled: boolean;
  /** Files or folders inside the app that are there but cannot be read (`.mcp.json`, a skills folder, a `SKILL.md`), relative with `/`. */
  readonly unreadable: readonly string[];
  /** The folders `marmeon-*` with a mark, in the order of `SKILL_FOLDERS`; the names come from the disk and are never trusted as text. */
  readonly found: readonly { readonly folder: SkillFolder; readonly name: string }[];
}

export interface InstallRefusal {
  readonly kind: 'install';
  readonly message: string;
  /** The file of the app the refusal is about, relative with `/`; absent when it concerns no single file. */
  readonly path?: string;
}

export interface InstallOptions {
  /** Install into `.agents/skills/` instead of `.claude/skills/`, where no skills lie yet. */
  readonly shared: boolean;
  /** Enter `marmeon mcp` in `.mcp.json` when nothing is installed yet, and keep an entry that is there current. */
  readonly mcp: boolean;
}

/**
 * Works out what `agents:install` would write and refuses, before anything is written, whatever it must not touch: a link that
 * leads nowhere or out of the app, a path part that is no directory, a skill or `.mcp.json` that is no regular file, a `SKILL.md` the framework did not mark (a file of the app), one marked by a newer `marmeon`, and a
 * `.mcp.json` it cannot read as an object. Skills go where skills with the mark already lie (both folders, if both), else to
 * `.agents/skills/` with `shared`, else to `.claude/skills/`. See docs/agents.md#skills-and-the-mcp-server.
 */
export function planInstall(root: string, shipped: readonly { name: string; text: string }[], options: InstallOptions): Result<InstallPlan, InstallRefusal> {
  const refuse = (message: string, path?: string) => err({ kind: 'install' as const, message, ...(path === undefined ? {} : { path }) });
  const warnings: string[] = [];

  for (const skill of shipped) {
    if (!skill.name.startsWith(PREFIX) || !/^[a-z0-9-]+$/.test(skill.name)) return refuse(`The skill "${skill.name}" does not start with "${PREFIX}"; marmeon installs only its own folders. Nothing was written.`);
  }

  const installedIn: string[] = [];
  const found: { folder: SkillFolder; name: string }[] = [];
  const unreadable: string[] = [];
  const retired: string[] = [];
  const seen = new Set<string>();
  for (const folder of Object.values(SKILL_FOLDERS)) {
    // A folder that is a link to the other one is the same folder: it is written once.
    const real = realOrSelf(join(root, ...folder.split('/')));
    if (seen.has(real)) continue;
    seen.add(real);
    const marked = markedFolders(root, folder, unreadable);
    if (marked.length > 0) installedIn.push(folder);
    for (const name of marked) found.push({ folder, name });
    for (const name of marked) if (!shipped.some((skill) => skill.name === name)) retired.push(`${folder}/${name}`);
  }
  const skillsInstalled = installedIn.length > 0;
  const targets = skillsInstalled ? installedIn : [options.shared ? SKILL_FOLDERS.shared : SKILL_FOLDERS.claude];
  const sameFolder = realOrSelf(join(root, ...SKILL_FOLDERS.claude.split('/'))) === realOrSelf(join(root, ...SKILL_FOLDERS.shared.split('/')));
  if (options.shared && !sameFolder && installedIn.includes(SKILL_FOLDERS.claude) && !installedIn.includes(SKILL_FOLDERS.shared)) {
    warnings.push(`The skills lie in ${SKILL_FOLDERS.claude} already, so --shared was ignored. Move the folders marmeon-* to ${SKILL_FOLDERS.shared} yourself to change that.`);
  }

  const steps: InstallStep[] = [];
  for (const folder of targets) {
    for (const skill of shipped) {
      const path = `${folder}/${skill.name}/SKILL.md`;
      const file = join(root, ...path.split('/'));
      const problem = unsafePath(root, file);
      if (problem) return refuse(problem, path);
      const current = readIfThere(file);
      if (current === undefined) {
        steps.push({ kind: 'skill', path, text: skill.text, change: 'create' });
        continue;
      }
      const mark = skillMark(current);
      if (typeof mark === 'number' && mark > SKILL_FORMAT) return refuse(`${path} is marked with format ${mark}, newer than this marmeon writes. Update marmeon. Nothing was written.`, path);
      if (typeof mark !== 'number') return refuse(`${path} is not marmeon's (it has no valid mark). Rename your folder or remove it. Nothing was written.`, path);
      steps.push({ kind: 'skill', path, text: skill.text, change: normalize(current) === normalize(skill.text) ? 'unchanged' : 'update' });
    }
  }

  // The entry is handled like the skills: judged and updated where it is, added only when nothing is installed yet. A person who
  // installed without it, or took it out, is not asked again.
  const mcpFile = join(root, MCP_FILE);
  const mcpProblem = unsafePath(root, mcpFile);
  if (isUnreadable(mcpProblem)) unreadable.push(MCP_FILE);
  const mcpText = mcpProblem ? undefined : readIfThere(mcpFile);
  const mcpInstalled = mcpText !== undefined && hasMcpEntry(mcpText);
  if (options.mcp && (mcpInstalled || !skillsInstalled)) {
    if (mcpProblem) return refuse(mcpProblem, MCP_FILE);
    const merged = mergeMcpJson(mcpText);
    if (!merged.ok) return refuse(merged.error.message, MCP_FILE);
    steps.push({
      kind: 'mcp',
      path: MCP_FILE,
      text: merged.value.text,
      change: merged.value.change,
      ...(merged.value.replaced ? { note: `Replaced the entry marmeon in ${MCP_FILE} (it belongs to marmeon agents:install).` } : {}),
    });
  }
  return ok({ steps, retired, warnings, skillsInstalled, mcpInstalled, found, unreadable });
}

/**
 * What the app has installed, found the way `agents:install` finds it, so the block of `AGENTS.md`, `agents:install --check` and
 * `marmeon check` never disagree. A link out of the app counts as not installed. A skill or `.mcp.json` that cannot be read
 * (a permission, say) is a refusal: nothing is guessed.
 */
export function installedTools(root: string): Result<AgentTools, InstallRefusal> {
  let plan: Result<InstallPlan, InstallRefusal>;
  try {
    plan = planInstall(root, [], { shared: false, mcp: false });
  } catch (error) {
    // The code only: a message of Node names the absolute path.
    const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
    return err({ kind: 'install', message: `The skills or .mcp.json could not be read (${code}). Nothing was written.` });
  }
  if (!plan.ok) return plan;
  const { found, mcpInstalled, unreadable } = plan.value;
  if (unreadable.length > 0) return err({ kind: 'install', message: `${JSON.stringify(unreadable[0])} ${UNREADABLE}`, path: unreadable[0]! });
  const skillFolder = found[0]?.folder;
  return ok({ skillFolder, skills: new Set(found.filter((skill) => skill.folder === skillFolder).map((skill) => skill.name)), mcp: mcpInstalled });
}

/** The names of the folders `marmeon-*` of `folder` whose `SKILL.md` carries a mark. A folder that is a link, or a file that is unsafe, is not one of them. */
function markedFolders(root: string, folder: string, unreadable: string[]): string[] {
  const directory = join(root, ...folder.split('/'));
  const directoryProblem = unsafePath(root, directory, 'directory');
  if (directoryProblem !== undefined) {
    if (isUnreadable(directoryProblem)) unreadable.push(folder);
    return [];
  }
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(folder);
    return [];
  }
  return entries
    // A link to a directory inside the app counts, so a folder reached through one is found again.
    .filter((entry) => entry.name.startsWith(PREFIX) && isDirectory(join(directory, entry.name), () => unreadable.push(`${folder}/${entry.name}`)))
    .filter((entry) => {
      const file = join(directory, entry.name, 'SKILL.md');
      const problem = unsafePath(root, file);
      if (isUnreadable(problem)) unreadable.push(`${folder}/${entry.name}/SKILL.md`);
      const text = problem === undefined ? readIfThere(file) : undefined;
      return text !== undefined && typeof skillMark(text) === 'number';
    })
    .map((entry) => entry.name)
    .sort();
}

/** The text without a byte order mark and with `\n` line ends: a checkout that turns line ends or adds a mark has not changed the skill. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Whether `path` is a directory; `unreadable` is called when it cannot be inspected (anything but a path that is not there). */
function isDirectory(path: string, unreadable: () => void): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable();
    return false;
  }
}

function readIfThere(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
