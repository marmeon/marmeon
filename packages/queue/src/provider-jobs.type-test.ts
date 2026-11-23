// What `static [providerJobs]` of a provider accepts — checked by `tsc` (typecheck), never run.
import { Logger, providerJobs, type ServiceProviderClass } from '@marmeon/core';
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
  static [providerJobs] = [Dependent, Constant];
};
export const frozen: ServiceProviderClass = class {
  static [providerJobs] = [Dependent, Constant] as const;
};

// @ts-expect-error a job class needs handle()
export const withoutHandle: ServiceProviderClass = class { static [providerJobs] = [NoHandle]; };

// @ts-expect-error a job class needs static schema
export const withoutSchema: ServiceProviderClass = class { static [providerJobs] = [NoSchema]; };

// @ts-expect-error names are not classes
export const strings: ServiceProviderClass = class { static [providerJobs] = ['test.dependent']; };

// @ts-expect-error a single class is not a list
export const notAList: ServiceProviderClass = class { static [providerJobs] = Constant; };

class Other {
  static readonly job = 'test.other';
  static readonly schema = v.object({ flag: v.boolean() });
  handle(_payload: JobPayload<typeof Other>): void {}
}

// A parent annotated with the list type, and a subclass that spreads it and adds a job with another schema.
class Parent {
  static [providerJobs]: readonly JobClass[] = [Constant];
}
export class Child extends Parent {
  static override [providerJobs] = [...super[providerJobs], Other];
}
export const extended: ServiceProviderClass = Child;

// A static or an instance member named `jobs`, of any type, is no concern of the queue: an interface and classes with it compile.
export const otherType: ServiceProviderClass = class {
  static jobs = 'not a list';
  register(): void {}
};
export const methodJobs: ServiceProviderClass = class {
  static jobs(): number {
    return 1;
  }
  register(): void {}
};
export const privateJobs: ServiceProviderClass = class {
  private static jobs = [1, 2];
  register(): void {}
};
export const protectedJobs: ServiceProviderClass = class {
  protected static jobs = new Set<string>();
  register(): void {}
};
export interface WithOwnJobs extends ServiceProviderClass {
  jobs: Map<string, number>;
}

// The symbol and a string `jobs` live side by side, each with its own type.
export const both: ServiceProviderClass = class {
  static jobs = 42;
  static [providerJobs] = [Constant];
};

// @ts-expect-error the symbol's list holds job classes, not numbers
export const numbers: ServiceProviderClass = class { static [providerJobs] = [1]; };

// A registry subclass may declare members of its own named like what the package keeps apart.
import { JobRegistry } from './registry.ts';
export class MyRegistry extends JobRegistry {
  addFromProvider(job: string): number {
    return job.length;
  }
  providerSourceOf(): boolean {
    return true;
  }
}

// The form an `isolatedDeclarations` build needs: the list is set in a static block, and `satisfies` checks it.
export class Assigned {
  register(): void {}
  static {
    Object.assign(this, { [providerJobs]: [Dependent, Constant] satisfies readonly JobClass[] });
  }
}

export class AssignedWrong {
  register(): void {}
  static {
    // @ts-expect-error a number is no job class
    Object.assign(this, { [providerJobs]: [1] satisfies readonly JobClass[] });
  }
}
