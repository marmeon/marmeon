import { island, type HttpContext } from '@marmeon/http';

/**
 * A controller for tests whose route plays an island: it answers with `answer`'s result (a redirect, a 401, a hanging
 * promise, an `island()`), or an island when that is nothing. The `island()` call inside the class is what the loader marks
 * the controller by — a bare closure is no island route.
 */
export function islandRoute(answer: (ctx: HttpContext) => unknown = () => undefined) {
  return class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test double answers with whatever its test needs
    handle(ctx: HttpContext): any {
      return answer(ctx) ?? island('test/Island', {});
    }
  };
}
