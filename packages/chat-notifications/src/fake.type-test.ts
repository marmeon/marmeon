// Type guarantees of the chat fake's matches — checked by `tsc` (pnpm build / typecheck), never run.
import { describe, expectTypeOf, it } from 'vitest';
import type { ChatFake, RecordedChatMessage } from './fake.ts';

describe('chat fake types', () => {
  it('takes only to, title and text, and a function of the recorded message', () => {
    const chat = {} as ChatFake;
    chat.assertSent({ to: 'ops', title: 'x', text: 'y' });
    // @ts-expect-error — `fields` is not something a match looks for.
    chat.assertSent({ fields: [] });
    // @ts-expect-error — `to` is a destination, not a number.
    chat.assertSent({ to: 1 });
    chat.assertSent((message) => {
      expectTypeOf(message).toEqualTypeOf<RecordedChatMessage>();
      return true;
    });
  });
});
