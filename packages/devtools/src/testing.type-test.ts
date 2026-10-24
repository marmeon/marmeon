import type { DevtoolsTester } from './testing.ts';

// An app types a variable with the tester; `createTestApp()` makes it.
export type AppSide = DevtoolsTester;

// @ts-expect-error — `DevtoolsTester` is exported as a type only: an app cannot construct it.
new DevtoolsTester(undefined as never, undefined as never);
