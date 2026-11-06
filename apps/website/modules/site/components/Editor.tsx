import { type ReactNode, useId } from 'react';
import { CodeBlock } from './CodeBlock.tsx';
import { Tabs } from './Tabs.tsx';

export interface EditorFile {
  readonly name: string;
  /** Shiki's output for the file, from the server. */
  readonly html: string;
}

interface EditorBase {
  /** The window's accessible name. */
  readonly label: string;
  readonly files: readonly EditorFile[];
  /** Shown under the code. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

export type EditorProps = EditorBase &
  (
    | {
        /** File tabs once hydrated, the files stacked under headings without JavaScript. */
        readonly layout?: 'tabs';
        /** The level of the file names: one below the heading the window sits under (default 4, inside a section's `<h3>`). */
        readonly headingLevel?: 3 | 4;
      }
    | {
        /** The files side by side, one under the other on a narrow screen. */
        readonly layout: 'split';
        /** As for `tabs`; `null` makes the names plain text, for a window under the page's `<h1>` where a heading level would be skipped. */
        readonly headingLevel?: 3 | 4 | null;
      }
  );

function Code({ html }: { html: string }) {
  return (
    <div className="editor-code">
      <CodeBlock copy={false} html={html} />
    </div>
  );
}

/**
 * A dark window for code, an illustration: file names in a title bar, no copy button. `files` hold Shiki's server output, never text from a user.
 * The window sets its own syntax colours (`--editor-syn-*`), the docs' code blocks stay light.
 */
export function Editor({ label, files, layout = 'tabs', footer, headingLevel = 4, className }: EditorProps) {
  const id = useId();
  const Name = headingLevel === null ? 'p' : (`h${headingLevel}` as const);
  const classes = ['editor', `editor--${layout}`, className].filter(Boolean).join(' ');
  const single = files.length === 1 ? files[0] : undefined;
  return (
    <div role="group" aria-label={label} className={classes}>
      {layout === 'tabs' && !single ? (
        <Tabs
          label={label}
          idPrefix={`editor-${id.replaceAll(':', '')}`}
          headingLevel={headingLevel ?? 4}
          items={files.map((file) => ({ id: file.name.replace(/[^A-Za-z0-9]+/g, '-'), label: file.name, content: <Code html={file.html} /> }))}
          itemClassName="editor-file"
          className="editor-tabs"
        />
      ) : (
        <div className="editor-files">
          {files.map((file) => (
            <div key={file.name} className="editor-file">
              <Name className="editor-name">{file.name}</Name>
              <Code html={file.html} />
            </div>
          ))}
        </div>
      )}
      {footer && <div className="editor-footer">{footer}</div>}
    </div>
  );
}
