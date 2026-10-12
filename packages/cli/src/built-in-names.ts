/**
 * The names of the commands the CLI itself provides. An app's command with one of these names makes marmeon refuse to start
 * (or, for a built-in that runs without booting, the built-in runs instead); a generator checks against this list. `main.ts` keeps it in step (a test compares both).
 */
export const BUILT_IN_NAMES: readonly string[] = [
  'serve',
  'route:list',
  'route:types',
  'modules:check',
  'discover',
  'build',
  'package:build',
  'key:generate',
  'tinker',
  'make:module',
  'make:controller',
  'make:event',
  'make:listener',
  'make:job',
  'make:notification',
  'make:command',
  'make:seeder',
  'make:middleware',
  'make:migration',
  'make:lint-config',
  'make:docker',
  'list',
  'help',
];
