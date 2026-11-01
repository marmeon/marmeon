// Type guarantees of an action's data — it stays as the request takes it (a numeric string, a defaulted key left out) — checked by `tsc`, never run.
import type { ActionFields } from './use-form.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Body = { count: number | `${number}`; limit?: number | `${number}`; agree: 'on' | boolean | 0 | 1 | '0' | '1' | 'true' | 'false' | 'off' | 'yes' | 'no' };

export function actionData(count: Equal<ActionFields<Body>['count'], number | `${number}`>, limit: Equal<ActionFields<Body>['limit'], number | `${number}` | undefined>, agree: Equal<ActionFields<Body>['agree'], boolean>) {
  const checked: true[] = [count, limit, agree];
  const sent: ActionFields<Body> = { count: '3', agree: true };
  return [checked, sent];
}
