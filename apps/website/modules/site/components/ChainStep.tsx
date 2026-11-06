import type { ReactNode } from 'react';

/**
 * One step of "one type, end to end": a number on the rail that joins the steps (drawn in CSS), what the step is, the code
 * that uses the type, and — where there is one — the misspelt line that no longer compiles with the compiler's answer. The code comes as children.
 */
export function ChainStep({ number, title, where, mistake, error, children }: { number: number; title: string; where: ReactNode; mistake?: string; error?: { code: string; message: string }; children: ReactNode }) {
  return (
    <li className="chain-step">
      <div className="chain-rail" aria-hidden="true">
        <span className="chain-number">{number}</span>
      </div>
      <div className="chain-body">
        <div className="chain-text">
          <h3>{title}</h3>
          {where}
        </div>
        <div className="chain-code">
          {children}
          {mistake !== undefined && (
            <p className="chain-mistake">
              <span className="visually-hidden">This does not compile: </span>
              <code>{mistake}</code>
            </p>
          )}
          {error !== undefined && (
            <p className="chain-error">
              <span className="chain-error-code">error {error.code}:</span> {error.message}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
