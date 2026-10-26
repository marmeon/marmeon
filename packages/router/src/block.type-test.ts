// The spans of `block()` by name — checked by `tsc`, never run.
import type { RouteDefinition } from './index.ts';

export function blocks(route: RouteDefinition): void {
  route.block();
  route.block({ lock: 5 });
  route.block({ lock: 5, wait: { seconds: 2 } });
  // @ts-expect-error — the two positional spans are gone.
  route.block(5, 2);
  // @ts-expect-error — a lone span is no options object.
  route.block(5);
  // @ts-expect-error — `seconds` belongs inside `lock` or `wait`.
  route.block({ seconds: 5 });
}
