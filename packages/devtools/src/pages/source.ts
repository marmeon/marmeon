/**
 * Where a controller or a view is in the app's sources — for the in-page bar's "open in editor": Vite's
 * `/__open-in-editor` opens a file, the bar knows a controller's class name (the request entry's `controller`) and a page's
 * component (`users/Show`). Read only, inside the app's root only: a controller is found by `export class <Name>` in the app's
 * modules, a view by the page naming convention (`modules/<module>/views/<Page>.tsx`). Nothing runs, nothing is written.
 */
import { existsSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** A place in a source file: absolute, as shown (relative to the app's root), and Vite's editor link. */
export interface SourceLocation {
  readonly file: string;
  readonly display: string;
  readonly line: number;
  /** `/__open-in-editor?file=…:line` — Vite's dev server opens it (`LAUNCH_EDITOR`). */
  readonly editor: string;
}

/** A class name — nothing else is looked for. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,127}$/;
/** A page component (`user-profile/Show`, `users/settings/Edit`): segments of word characters and dashes, no `..`. */
const COMPONENT = /^[\w-]+(?:\/[\w-]+)+$/;
/** Where controllers live — every module file but tests (`ShowLabPageController.ts` holds several). */
const SOURCES = ['modules/**/*.ts', 'app/**/*.ts'];

const location = (root: string, file: string, line: number): SourceLocation => ({
  file,
  display: relative(root, file).split(sep).join('/'),
  line,
  editor: `/__open-in-editor?file=${encodeURIComponent(`${file}:${line}`)}`,
});

/** Whether `file` is inside `root` (no way out through `..` or a link's name). */
const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
};

/** The file and line of `export class <name>` in the app's modules — undefined when there is none (or the name is no class name). */
export async function findController(root: string, name: string): Promise<SourceLocation | undefined> {
  if (!IDENTIFIER.test(name)) return undefined;
  const declaration = new RegExp(`^export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+${name.replaceAll('$', '\\$')}\\b`, 'm');
  for (const pattern of SOURCES) {
    for await (const found of glob(pattern, { cwd: root, exclude: (path) => /node_modules|(^|\/)dist\/|\.test\.ts$/.test(String(path)) })) {
      const file = join(root, found);
      if (!inside(root, file)) continue;
      const text = await readFile(file, 'utf8').catch(() => '');
      const match = declaration.exec(text);
      if (match) return location(root, file, text.slice(0, match.index).split('\n').length);
    }
  }
  return undefined;
}

/** The file of page component `component` (`users/Show` → `modules/users/views/Show.tsx`) — undefined when it is not there. */
export function findView(root: string, component: string): SourceLocation | undefined {
  if (!COMPONENT.test(component)) return undefined;
  const [module, ...rest] = component.split('/');
  for (const extension of ['tsx', 'jsx']) {
    const file = join(root, 'modules', module!, 'views', `${rest.join('/')}.${extension}`);
    if (inside(root, file) && existsSync(file)) return location(root, file, 1);
  }
  return undefined;
}
