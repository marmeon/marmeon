// Framework-neutral: no dependency on BespokeCore. A token is only { key, name }.
export interface Clock {
  now(): string;
}
export const Clock: { readonly key: symbol; readonly name: string; readonly __type?: Clock } = {
  key: Symbol('Clock'),
  name: 'Clock',
};

export class SystemClock implements Clock {
  now() {
    return '09:00';
  }
}

interface Bindings {
  bind(key: unknown, concrete: unknown): unknown;
}

export class ClockServiceProvider {
  register(container: Bindings) {
    container.bind(Clock, SystemClock);
  }
}
