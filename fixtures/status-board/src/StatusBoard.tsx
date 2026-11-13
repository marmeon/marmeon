import { Link } from '@marmeon/react';
import { Badge } from './Badge.tsx';
import './status-board.css';

export interface Service {
  readonly name: string;
  readonly state: 'up' | 'degraded' | 'down';
}

/** A list of services with their state, and a link to a route of the app: markup an app page renders and the browser hydrates. */
export function StatusBoard({ services }: { services: readonly Service[] }) {
  return (
    <section className="status-board" aria-label="Services">
      <ul>
        {services.map((service) => (
          <li key={service.name}>
            {service.name} <Badge state={service.state} />
          </li>
        ))}
      </ul>
      <Link route="auth.sensitive">Sensitive actions</Link>
    </section>
  );
}
