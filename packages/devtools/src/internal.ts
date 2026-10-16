/**
 * What the framework's own packages import from the devtools: the recorder and the opt-in of `createTestApp`. Not API, can change
 * in any release — an app imports from `@marmeon/devtools`.
 * @internal
 */
export { Recorder } from './recorder.ts';
export { enableDevtoolsForTests } from './test-opt-in.ts';
