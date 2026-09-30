import { token } from '../../token.ts';

export interface Clock {
  now(): string;
}
export const Clock = token<Clock>('Clock');

export class FixedClock implements Clock {
  now() {
    return '09:00';
  }
}

export class Greeter {
  greet(name: string) {
    return `Hello ${name}`;
  }
}
