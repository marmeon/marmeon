import type { ReactNode } from 'react';

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
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** "Seven principles": the rules the framework keeps, as a numbered list. */
export function PrinciplesSection() {
  return (
    <section className="principles" aria-labelledby="principles-title">
      <div className="landing-inner">
        <h2 id="principles-title" className="section-label">
          Seven principles
        </h2>
        <ol className="principle-list">
          {PRINCIPLES.map(({ name, text }, index) => (
            <li key={name} className="principle">
              <span className="principle-numeral" aria-hidden="true">
                {NUMERALS[index]}
              </span>
              <strong>{name}</strong>
              <span className="principle-text">{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
