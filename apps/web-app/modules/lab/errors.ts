import { Clock, SystemClock, token } from '@marmeon/core';
import type { LabConfig } from './config.ts';

/**
 * Classes that go wrong on purpose — for the lab's "trigger an error" page (`/lab/errors`, E119/E130): each one makes the
 * container fail in its own way, so the development error page shows its solution.
 */

/** Never bound in a provider: building {@link CheckoutService} fails ("unbound"). */
export interface PaymentGateway {
  charge(cents: number): Promise<void>;
}
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

export class CheckoutService {
  readonly payments: PaymentGateway;
  constructor(payments: PaymentGateway) {
    this.payments = payments;
  }
}

/** A primitive parameter: the injection transform cannot derive a list ("no injection list"). */
export class Money {
  readonly cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
}

/** A type-only import as a parameter's type: it does not exist at runtime (the injection transform says so). */
export class LabReport {
  readonly config: LabConfig;
  constructor(config: LabConfig) {
    this.config = config;
  }
}

/** Two classes that need each other ("circular"). */
export class Orders {
  static inject: unknown[] = [];
  readonly invoices: unknown;
  constructor(invoices: unknown) {
    this.invoices = invoices;
  }
}
export class Invoices {
  static inject = [Orders] as const;
  readonly orders: Orders;
  constructor(orders: Orders) {
    this.orders = orders;
  }
}
Orders.inject = [Invoices];

/**
 * The W6.6 mistake (E128): a defaulted parameter of an injectable type is never injected — a test's clock would not reach
 * it. The container builds it with the default and warns (development log, error page).
 */
export class ReminderSchedule {
  readonly clock: Clock;
  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }
}
