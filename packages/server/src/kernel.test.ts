import { Container } from '@bespokecore/core';
import { defineRoutes, Router } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

let created = 0;
class RequestId {
  readonly value = ++created;
}

class ShowRequestIdController {
  static inject = [RequestId, RequestId] as const;
  readonly #first: RequestId;
  readonly #second: RequestId;
  constructor(first: RequestId, second: RequestId) {
    this.#first = first;
    this.#second = second;
  }
  handle() {
    return { first: this.#first.value, second: this.#second.value };
  }
}

describe('createHttpKernel — container', () => {
  const router = new Router().load(defineRoutes((Route) => Route.get('/id', ShowRequestIdController)));
  const app = createHttpKernel(router, { container: new Container().scoped(RequestId) });

  it('resolves controllers from a fresh scope per request', async () => {
    type Ids = { first: number; second: number };
    const one = (await (await app.request('/id')).json()) as Ids;
    const two = (await (await app.request('/id')).json()) as Ids;

    expect(one.first).toBe(one.second); // same instance within a request
    expect(two.first).not.toBe(one.first); // new instance for the next request
  });
});
