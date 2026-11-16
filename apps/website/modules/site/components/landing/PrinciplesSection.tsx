import type { ReactNode } from 'react';
import { roman } from '../../../docs/roman.ts';

const PRINCIPLES: { name: string; text: ReactNode }[] = [
  { name: 'Typed end to end', text: 'From the database column through the controller, validation and route names to the form error in the React component.' },
  { name: 'No global state', text: 'No facades, no singletons holding request data: one application, a scope per request or job.' },
  { name: 'TypeScript runs natively on Node', text: 'No transpile step, no decorators.' },
  { name: 'Modules first', text: 'A module brings its routes, providers, migrations, views and tests; installed packages register themselves.' },
  {
    name: 'One endpoint, one class',
    text: (
      <>
        Controllers, jobs, listeners, commands, mails and policies are classes with <code>handle()</code>.
      </>
    ),
  },
  { name: 'Batteries included, behind contracts', text: 'Mail, the queue, notifications, storage, events, live updates and the schedule each have a fake for tests.' },
  { name: 'Secure by default', text: 'In production, and wherever nobody set the environment, protections stay on.' },
];

/** "Seven rules, set in stone": the principles the framework keeps, as a numbered list. */
export function PrinciplesSection() {
  return (
    <section className="principles landing-light" aria-labelledby="principles-title">
      <div className="landing-inner">
        <div className="principles-frame">
          <div className="principles-head">
            <div>
              <p className="section-label">Seven principles</p>
              <h2 id="principles-title">
                Seven rules, <span className="serif-accent">set in stone.</span>
              </h2>
            </div>
            <p>The principles every part of the framework follows.</p>
          </div>
          <ol className="principle-list">
            {PRINCIPLES.map(({ name, text }, index) => (
              <li key={name} className="principle">
                <span className="principle-numeral" aria-hidden="true">
                  {roman(index + 1)}
                </span>
                <h3>{name}</h3>
                <p className="principle-text">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
