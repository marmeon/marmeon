import type { ReactNode } from 'react';
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
  /** `tabs`: file tabs once hydrated, the files stacked without JavaScript. `split`: the files side by side, one under the other on a narrow screen. */
  readonly layout?: 'tabs' | 'split';
  /** Shown under the code. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

function Code({ html }: { html: string }) {
  // marmeon-check-ignore inner-html: `html` is the Shiki output of the server (modules/docs/highlight.ts), which escapes the code it highlights
  return <div className="editor-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * A dark window for code, an illustration: file names in a title bar, no copy button. `files` hold Shiki's server output, never text from a user.
 * The window sets its own syntax colours (`--editor-syn-*`), the docs' code blocks stay light.
 */
export function Editor({ label, files, layout = 'tabs', footer, className }: EditorProps) {
  const classes = ['editor', `editor--${layout}`, className].filter(Boolean).join(' ');
  const single = files.length === 1 ? files[0] : undefined;
  return (
    <div role="group" aria-label={label} className={classes}>
      {layout === 'tabs' && !single ? (
        <Tabs
          label={label}
          idPrefix={`editor-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          items={files.map((file) => ({ id: file.name.replace(/[^A-Za-z0-9]+/g, '-'), label: file.name, content: <Code html={file.html} /> }))}
          itemClassName="editor-file"
          className="editor-tabs"
        />
      ) : (
        <div className="editor-files">
          {files.map((file) => (
            <div key={file.name} className="editor-file">
              <p className="editor-name">{file.name}</p>
              <Code html={file.html} />
            </div>
          ))}
        </div>
      )}
      {footer && <div className="editor-footer">{footer}</div>}
    </div>
  );
}
