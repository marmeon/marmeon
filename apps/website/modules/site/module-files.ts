/**
 * The folder of `modules/notes/` the landing's "Modules" tab draws — server only, listed by `BatteriesSection`. `scripts/landing.ts`
 * checks every entry against the smoke app: a folder (`folder: true`, name ending in `/`) is a directory there, a file is a file.
 */
export interface ModuleFile {
  readonly name: string;
  readonly folder?: boolean;
  readonly role: string;
}

export const MODULE_FILES: readonly ModuleFile[] = [
  { name: 'routes.ts', role: 'routes and their names' },
  { name: 'controllers/', folder: true, role: 'one class per endpoint' },
  { name: 'views/', folder: true, role: 'React pages' },
  { name: 'migrations/', folder: true, role: "the module's tables" },
  { name: 'policies/', folder: true, role: 'who may do what' },
  { name: 'notes.test.ts', role: 'tests, next to the code' },
  { name: 'index.ts', role: 'the definition, and what other modules may import' },
];
