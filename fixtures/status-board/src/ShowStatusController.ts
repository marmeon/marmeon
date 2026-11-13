import { Controller } from '@marmeon/http';
import type { Service } from './StatusBoard.tsx';

/** The area's first page: the services and their state. */
export class ShowStatusController extends Controller {
  handle() {
    const services: readonly Service[] = [
      { name: 'Web', state: 'up' },
      { name: 'Mail', state: 'degraded' },
    ];
    return this.view('status::Index', { services });
  }
}
