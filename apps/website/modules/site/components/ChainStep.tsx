import type { ReactNode } from 'react';

/**
 * One step of "one type, end to end": a number on the rail that joins the steps (drawn in CSS), what the step is, the code
 * that uses the type, and — where there is one — the misspelt line that no longer compiles. The code comes as children.
 */
export function ChainStep({ number, title, where, mistake, children }: { number: number; title: string; where: ReactNode; mistake?: string; children: ReactNode }) {
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
              <span className="chain-error" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M1 1l8 8M9 1l-8 8" />
                </svg>
                COMPILE ERROR
              </span>
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
