import { CopyButton } from './CopyButton.tsx';

/**
 * Shell commands on a dark panel in both themes. The `$` prompt is drawn apart from the text and is not copied.
 * `label` is the caption in the bar.
 */
export function Terminal({ commands, label = 'TERMINAL' }: { commands: readonly string[]; label?: string }) {
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="terminal-label">{label}</span>
        <CopyButton text={commands.join('\n')} label="Copy commands" />
      </div>
      <pre>
        <code>
          {commands.map((command, index) => (
            <span key={index} className="terminal-line">
              <span className="prompt" aria-hidden="true">
                {'$ '}
              </span>
              {command}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
