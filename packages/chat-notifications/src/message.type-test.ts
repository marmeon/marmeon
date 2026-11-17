// Type guarantees of the chat message and the guard — checked by `tsc` (pnpm build / typecheck), never run.
import { describe, expectTypeOf, it } from 'vitest';
import { checkSinkAddress, checkWebhook, type WebhookHref } from './destination.ts';
import type { ChatJson } from './driver.ts';
import type { ChatMessage, ChatRaw, ChatRawFormats } from './message.ts';

// A format as a driver package declares it: a type alias built from ChatJson.
type SlackFormat = { readonly blocks: readonly { readonly type: string }[] };
interface InterfaceFormat {
  readonly blocks: readonly string[];
}
type DateFormat = { readonly at: Date };
type UnknownListFormat = readonly unknown[];

describe('chat types', () => {
  it('accepts the built-in raw formats through ChatMessage, and only as JSON', () => {
    const fine: ChatMessage = {
      to: 'ops',
      text: 'x',
      raw: {
        slack: { blocks: [{ type: 'divider' }] },
        discord: { content: undefined, embeds: [{ title: 'x' }], allowedMentions: { everyone: true, users: 'all', roles: ['1'] } },
        teams: { card: { type: 'AdaptiveCard', version: '1.2', body: [] } },
      },
    };
    // @ts-expect-error a text is no raw value
    const text: ChatMessage = { to: 'ops', text: 'x', raw: 'text' };
    // @ts-expect-error `slakc` is no declared format
    const typo: ChatMessage = { to: 'ops', text: 'x', raw: { slakc: { blocks: [] } } };
    const date: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error a Date is no JSON
      raw: { slack: { blocks: [{ type: 'section', at: new Date() }] } },
    };
    const blocks: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error `blocks` is a list
      raw: { slack: { blocks: 'x' } },
    };
    const mention: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error users is 'all' or a list of ids
      raw: { discord: { allowedMentions: { users: 'any' } } },
    };
    const parse: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error `parse` is not a field of the format: the driver derives it
      raw: { discord: { content: 'x', allowedMentions: { parse: ['users'] } } },
    };
    const snake: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error `allowed_mentions` is not a key of the format
      raw: { discord: { content: 'x', allowed_mentions: { parse: [] } } },
    };
    const card: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error a card is an AdaptiveCard
      raw: { teams: { card: { type: 'Other', version: '1.2', body: [] } } },
    };
    const noBody: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error a card has a body
      raw: { teams: { card: { type: 'AdaptiveCard', version: '1.2' } } },
    };
    const noType: ChatMessage = {
      to: 'ops',
      text: 'x',
      // @ts-expect-error a block has a type
      raw: { slack: { blocks: [{ text: 'x' }] } },
    };
    expectTypeOf([fine, text, typo, date, blocks, mention, parse, snake, card, noBody, noType]).toBeArray();
  });

  it('declares every built-in raw format as JSON', () => {
    expectTypeOf<ChatRawFormats['slack']>().toExtend<ChatJson>();
    expectTypeOf<ChatRawFormats['discord']>().toExtend<ChatJson>();
    expectTypeOf<ChatRawFormats['teams']>().toExtend<ChatJson>();
    expectTypeOf<ChatRawFormats[keyof ChatRawFormats]>().toExtend<ChatJson>();
  });

  it('accepts no raw value while no format is declared', () => {
    expectTypeOf<ChatRaw<Record<never, never>>>().toBeNever();
    // @ts-expect-error without a declared format nothing is a raw value
    const none: ChatRaw<Record<never, never>> = {};
    expectTypeOf(none).toBeNever();
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
