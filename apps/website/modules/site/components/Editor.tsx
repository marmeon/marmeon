import { useId } from 'react';
import { CodeBlock } from './CodeBlock.tsx';
import { Tabs } from './Tabs.tsx';

export interface EditorFile {
  readonly name: string;
  /** Shiki's output for the file, from the server. */
  readonly html: string;
}

export interface EditorProps {
  /** The window's accessible name. */
  readonly label: string;
  readonly files: readonly EditorFile[];
  /** The level of the file names: one below the heading the window sits under (default 4, inside a section's `<h3>`). */
  readonly headingLevel?: 3 | 4;
  readonly className?: string;
}

function Code({ html }: { html: string }) {
  return (
    <div className="editor-code">
      <CodeBlock copy={false} html={html} />
    </div>
  );
}

/**
 * A dark window for code, an illustration: file names in a title bar, no copy button. `files` hold Shiki's server output, never text from a user.
 * Several files become file tabs once hydrated and stand under headings before; one file has its name as a heading.
 * The window sets its own syntax colours (`--editor-syn-*`), the docs' code blocks stay light.
 */
export function Editor({ label, files, headingLevel = 4, className }: EditorProps) {
  const id = useId();
  const Name = `h${headingLevel}` as const;
  const classes = ['editor', className].filter(Boolean).join(' ');
  const single = files.length === 1 ? files[0] : undefined;
  return (
    <div role="group" aria-label={label} className={classes}>
      {single ? (
        <div className="editor-files">
          <div className="editor-file">
            <Name className="editor-name">{single.name}</Name>
            <Code html={single.html} />
          </div>
        </div>
      ) : (
        <Tabs
          label={label}
          idPrefix={`editor-${id.replaceAll(':', '')}`}
          headingLevel={headingLevel}
          items={files.map((file) => ({ id: file.name.replace(/[^A-Za-z0-9]+/g, '-'), label: file.name, content: <Code html={file.html} /> }))}
          itemClassName="editor-file"
          className="editor-tabs"
        />
      )}
    </div>
  );
}
