/**
 * The folder of `modules/notes/` the landing's "Modules" card draws — server only, listed by `BatteriesSection`. `scripts/landing.ts`
 * checks every entry against the smoke app: a folder (`folder: true`, name ending in `/`) is a directory there, a file is a file.
 */
export interface ModuleFile {
  readonly name: string;
  readonly folder?: boolean;
}

export const MODULE_FILES: readonly ModuleFile[] = [
  { name: 'routes.ts' },
  { name: 'controllers/', folder: true },
  { name: 'views/', folder: true },
  { name: 'migrations/', folder: true },
  { name: 'policies/', folder: true },
  { name: 'notes.test.ts' },
  { name: 'index.ts' },
];
