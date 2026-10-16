import type { CommandClass, CommandInput } from '../command.ts';
import { style } from '../output.ts';

/** `marmeon` without arguments: every command, grouped by namespace. */
export function printCommandList({ output }: Pick<CommandInput, 'output'>, commands: readonly CommandClass[]): void {
  output.line(`${style('bold', 'Marmeon')}  ${style('dim', 'usage: marmeon <command> [arguments] [--options]')}`);
  const visible = [...LAUNCHER, ...commands.filter((command) => !command.hidden)];
  const width = Math.max(...visible.map((command) => command.command.length));
  let group: string | undefined;
  for (const command of visible.sort((a, b) => namespace(a).localeCompare(namespace(b)) || a.command.localeCompare(b.command))) {
    if (namespace(command) !== group) {
      group = namespace(command);
      output.line();
      output.line(style('yellow', group || 'Available commands'));
    }
    output.line(`  ${style('green', command.command.padEnd(width))}  ${command.description}${marker(command)}`);
  }
}

const marker = (command: Pick<CommandClass, 'experimental'>) => (command.experimental === true ? ` ${style('dim', '(experimental)')}` : '');

function namespace(command: Pick<CommandClass, 'command'>): string {
  return command.command.includes(':') ? command.command.split(':')[0]! : '';
}

/** Handled by the launcher (bin/marmeon.js), listed for completeness. */
const LAUNCHER = [
  { command: 'dev', description: 'Start the development server (restarts on changes, HMR for views)' },
  { command: 'start', description: 'Start the production server (after marmeon build)' },
] as unknown as CommandClass[];

/** `marmeon <command> --help`: what the command does, its usage line and its options. */
export function printCommandHelp({ output }: Pick<CommandInput, 'output'>, command: CommandClass): void {
  output.line(`${command.description}${marker(command)}`);
  output.line();
  output.line(`Usage: marmeon ${command.command} ${command.usage ?? ''}`.trimEnd());
  output.line();
  output.line('Options:');
  const rows = Object.entries(command.options ?? {}).map(([name, option]) => {
    const flag = `${option.short ? `-${option.short}, ` : ''}--${name}${option.type === 'string' ? '=<value>' : ''}`;
    const notes = [option.multiple ? 'repeatable' : '', option.default !== undefined ? `default: ${JSON.stringify(option.default)}` : ''].filter(Boolean);
    return [flag, notes.join(', ')] as const;
  });
  rows.push(['-h, --help', 'Show this help']);
  const width = Math.max(...rows.map(([flag]) => flag.length));
  for (const [flag, note] of rows) output.line(`  ${note ? `${flag.padEnd(width)}  ${note}` : flag}`);
}
