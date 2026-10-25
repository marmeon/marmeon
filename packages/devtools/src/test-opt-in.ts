import { token, type Container } from '@marmeon/core';
import { MemoryDevtoolsStore } from './store.ts';
import { DevtoolsTester } from './tester.ts';

/** A test's opt-in (`createTestApp(App, { devtools: true })`): the devtools run with a memory store, whatever `NODE_ENV` is (but production). */
export interface DevtoolsTestOptIn {
  readonly store: MemoryDevtoolsStore;
}
export const DevtoolsTestOptIn = token<DevtoolsTestOptIn>('DevtoolsTestOptIn');

/** Opts a test app in (before it boots — `createTestApp` calls it in `override`): a memory store, and the tester over it. */
export function enableDevtoolsForTests(container: Container): DevtoolsTester {
  const store = new MemoryDevtoolsStore();
  container.instance(DevtoolsTestOptIn, { store });
  return new DevtoolsTester(container, store);
}
