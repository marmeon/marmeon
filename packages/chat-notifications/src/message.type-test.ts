// Type guarantees of the chat message and the guard — checked by `tsc` (pnpm build / typecheck), never run.
import { describe, expectTypeOf, it } from 'vitest';
import { checkSinkAddress, checkWebhook, type WebhookHref } from './destination.ts';
import type { ChatJson } from './driver.ts';
import type { ChatMessage, ChatRaw } from './message.ts';

// A format as a driver package declares it: a type alias built from ChatJson.
type SlackFormat = { readonly blocks: readonly { readonly type: string }[] };
interface InterfaceFormat {
  readonly blocks: readonly string[];
}
type DateFormat = { readonly at: Date };
type UnknownListFormat = readonly unknown[];

describe('chat types', () => {
  it('accepts no raw value while no format is declared', () => {
    // @ts-expect-error without a declared format a text is no raw value
    const text: ChatMessage = { to: 'ops', text: 'x', raw: 'text' };
    // @ts-expect-error without a declared format a list is no raw value
    const list: ChatMessage = { to: 'ops', text: 'x', raw: [] };
    // @ts-expect-error without a declared format no key is known
    const keyed: ChatMessage = { to: 'ops', text: 'x', raw: { slack: {} } };
    const without: ChatMessage = { to: 'ops', text: 'x' };
    expectTypeOf([text, list, keyed, without]).toBeArray();
  });

  it('accepts the declared formats only, and only as JSON', () => {
    type Raw = ChatRaw<{ slack: SlackFormat; list: readonly string[] }>;
    const fine: Raw = { slack: { blocks: [{ type: 'divider' }] }, list: ['a'] };
    // @ts-expect-error a text is no raw value
    const text: Raw = 'text';
    // @ts-expect-error `slak` is no declared format
    const typo: Raw = { slak: { blocks: [] } };
    // @ts-expect-error `blocks` is declared as a list
    const wrong: Raw = { slack: { blocks: 'x' } };
    const date: ChatRaw<{ slack: DateFormat }> = {
      // @ts-expect-error a Date is no JSON
      slack: { at: new Date() },
    };
    const iface: ChatRaw<{ slack: InterfaceFormat }> = {
      // @ts-expect-error an interface-typed format does not compile: its type names the rule
      slack: { blocks: ['a'] },
    };
    const unknownList: ChatRaw<{ slack: UnknownListFormat }> = {
      // @ts-expect-error a list of unknown is no JSON
      slack: [1],
    };
    expectTypeOf([fine, text, typo, wrong, date, iface, unknownList]).toBeArray();
  });

  it('refuses what is no JSON', () => {
    // @ts-expect-error undefined is no JSON
    const undef: ChatJson = { a: undefined };
    // @ts-expect-error a Date is no JSON
    const date: ChatJson = new Date();
    // @ts-expect-error a Map is no JSON
    const map: ChatJson = new Map();
    // @ts-expect-error a class instance is no JSON
    const instance: ChatJson = new (class Thing {
      run(): void {}
    })();
    // @ts-expect-error a function is no JSON
    const fn: ChatJson = { run: () => 1 };
    expectTypeOf([undef, date, map, instance, fn]).toBeArray();
  });

  it('needs a text and a destination of the right kind', () => {
    // @ts-expect-error `text` is required
    const noText: ChatMessage = { to: 'ops' };
    // @ts-expect-error `to` is a name or an object
    const badTo: ChatMessage = { to: 5, text: 'x' };
    expectTypeOf([noText, badTo]).toBeArray();
  });

  it('needs a rule to check a webhook address against', () => {
    // @ts-expect-error the rule is required
    const result = checkWebhook('https://example.com/x');
    expectTypeOf(result).toBeObject();
  });

  it('gives no WebhookHref for a sink address', () => {
    const sink = checkSinkAddress('https://example.com/x');
    if (sink.ok) {
      // @ts-expect-error a sink result carries no checked address
      expectTypeOf(sink.href).toEqualTypeOf<WebhookHref>();
    }
  });
});
