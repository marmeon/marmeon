/**
 * The names of the commands the CLI itself provides. They are registered after the app's, so a command of an app with one of
 * these names is never reached; a generator checks against this list. `main.ts` keeps it in step (a test compares both).
 */
export const BUILT_IN_NAMES: readonly string[] = [
  'serve',
  'route:list',
  'route:types',
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
