import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { defineRequest, type ContextOf, type FormOf, type SchemaOf } from './request-definition.ts';
import type { HttpContext } from './types.ts';

interface Event {
  id: number;
  questions: string[];
}

const AnswersRequest = defineRequest({
  schema: async (_resolve, ctx: HttpContext<{}, { event: Event }>) => {
    const keys: string[] = ctx.params.event.questions;
    return v.object({ answers: v.record(v.string(), v.string()), size: v.optional(v.string()), count: v.number(), keys: v.literal(keys.length) });
  },
});

class AnswersController {
  static request = AnswersRequest;
  handle(ctx: ContextOf<typeof AnswersRequest>) {
    return ctx.body.answers;
  }
}

// The client types see the schema the factory builds, not its promise.
expectTypeOf<SchemaOf<typeof AnswersRequest>>().toMatchTypeOf<v.GenericSchema>();
expectTypeOf<FormOf<AnswersController>['answers']>().toEqualTypeOf<Record<string, string>>();
expectTypeOf<FormOf<AnswersController>['count']>().toEqualTypeOf<number>();
// @ts-expect-error -- 2: `sizes` is no field of the built schema
const missing: FormOf<AnswersController>['sizes'] = undefined;

// A synchronous factory builds the same form.
const SyncRequest = defineRequest({ schema: (_resolve, _ctx: HttpContext) => v.object({ title: v.string() }) });
class SyncController {
  static request = SyncRequest;
  handle(ctx: ContextOf<typeof SyncRequest>) {
    return ctx.body.title;
  }
}
expectTypeOf<FormOf<SyncController>>().toEqualTypeOf<{ title: string }>();

defineRequest({
  // @ts-expect-error -- 3: the factory's context and the one of `authorize` must agree
  schema: (_resolve, _ctx: HttpContext<{ user: string }>) => v.object({}),
  authorize: (ctx: HttpContext<{ user: number }>) => ctx.user > 0,
});

// @ts-expect-error -- 4: a factory returns a schema (or a promise of one), not a plain object
defineRequest({ schema: async () => ({ title: 'x' }) });

void missing;
