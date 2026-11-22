// What `static jobs` of a provider accepts — checked by `tsc` (typecheck), never run.
import { Logger, type ServiceProviderClass } from '@marmeon/core';
import * as v from 'valibot';
import type { JobClass, JobPayload } from './job.ts';
import './index.ts';

class Dependent {
  static readonly job = 'test.dependent';
  static readonly schema = v.object({ id: v.number() });
  static readonly inject = [Logger];
  readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger;
  }
  handle(_payload: JobPayload<typeof Dependent>): void {}
}

class Constant {
  static readonly job = 'test.constant';
  static readonly schema = v.object({});
  handle(): void {}
}

class NoHandle {
  static readonly job = 'test.no-handle';
  static readonly schema = v.object({});
}

class NoSchema {
  static readonly job = 'test.no-schema';
  handle(): void {}
}

// A class with dependencies, a mutable list, and `as const`.
export const accepted: ServiceProviderClass = class {
  static jobs = [Dependent, Constant];
};
export const frozen: ServiceProviderClass = class {
  static jobs = [Dependent, Constant] as const;
};

// @ts-expect-error a job class needs handle()
export const withoutHandle: ServiceProviderClass = class { static jobs = [NoHandle]; };

// @ts-expect-error a job class needs static schema
export const withoutSchema: ServiceProviderClass = class { static jobs = [NoSchema]; };

// @ts-expect-error names are not classes
export const strings: ServiceProviderClass = class { static jobs = ['test.dependent']; };

// @ts-expect-error a single class is not a list
export const notAList: ServiceProviderClass = class { static jobs = Constant; };

class Other {
  static readonly job = 'test.other';
  static readonly schema = v.object({ flag: v.boolean() });
  handle(_payload: JobPayload<typeof Other>): void {}
}

// A parent annotated with the list type, and a subclass that spreads it and adds a job with another schema.
class Parent {
  static jobs: readonly JobClass[] = [Constant];
}
export class Child extends Parent {
  static override jobs = [...super.jobs, Other];
}
export const extended: ServiceProviderClass = Child;
