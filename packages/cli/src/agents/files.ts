import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

export function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Why `file` may not be read or written: a link that leads nowhere or out of the app, or something that is no file (a directory, a pipe), or that cannot be read. A file that is not there is fine. */
export function unsafe(root: string, file: string): string | undefined {
  if (!exists(file)) return undefined;
  const name = file.slice(root.length + 1);
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return `${name} is a link that leads nowhere. Remove it or fix it, then run marmeon agents:sync again. Nothing was written.`;
  }
  const inside = realpathSync(root);
  if (real !== inside && !real.startsWith(inside + sep)) return `${name} is a link to ${real}, outside the app. Nothing was written.`;
  if (!statSync(real).isFile()) return `${name} is not a file. Nothing was written.`;
  try {
    accessSync(real, constants.R_OK);
  } catch {
    return `${name} cannot be read. Nothing was written.`;
  }
  return undefined;
}
