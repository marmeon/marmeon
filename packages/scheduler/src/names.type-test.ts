// What a class that `s.call()` runs is called — checked by `tsc` (pnpm build / typecheck), never run.
import type { CallableTask, CallableTaskClass } from './index.ts';
// @ts-expect-error — `CallableTask` is the class `s.call()` runs; `Invokable` is not exported
import type { Invokable } from './index.ts';
// @ts-expect-error — `CallableTaskClass` is its constructor type; `InvokableClass` is not exported
import type { InvokableClass } from './index.ts';

export type Callable = [CallableTask, CallableTaskClass, Invokable, InvokableClass];
