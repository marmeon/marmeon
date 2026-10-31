import type { StandardSchemaV1 } from '@marmeon/core';
import { parseQuery, translatable } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { metaOf, rules as r, type Rule } from './index.ts';
import { contentsOf } from './internal.ts';

type Result = { value?: unknown; issues?: readonly { message: string; path?: readonly PropertyKey[] }[] };

/** A rule's answer — awaited (async rules return a Promise). */
async function check(rule: StandardSchemaV1, value: unknown): Promise<Result> {
  return (await rule['~standard'].validate(value)) as Result;
}

/** The messages by field, as a form shows them. */
async function errors(rule: StandardSchemaV1, value: unknown): Promise<Record<string, string[]>> {
  const result = await check(rule, value);
  const by: Record<string, string[]> = {};
  for (const issue of result.issues ?? []) (by[(issue.path ?? []).map(String).join('.') || '_'] ??= []).push(issue.message);
  return by;
}

describe('the types', () => {
  it('a string: missing is "required", another type "must be a string" — and no NUL character (Postgres refuses it: a 500, not a 422)', async () => {
    const form = r.object({ name: r.string() });
    expect(await check(form, { name: '' })).toEqual({ value: { name: '' } });
    expect(await errors(form, {})).toEqual({ name: ['The name field is required.'] });
    expect(await errors(form, { name: null })).toEqual({ name: ['The name field is required.'] });
    expect(await errors(form, { name: 42 })).toEqual({ name: ['The name field must be a string.'] });
    const nul = await check(form, { name: 'a\0b' });
    expect(nul.issues?.[0]?.message, 'a string with a NUL character').toBe('The name field must be a string.');
  });

  it('numbers take what a form or a URL spells — in decimal, finite', async () => {
    const form = r.object({ age: r.number(), count: r.integer() });
    expect(await check(form, { age: '36.5', count: '3' })).toEqual({ value: { age: 36.5, count: 3 } });
    expect(await check(form, { age: -2, count: 1e3 })).toEqual({ value: { age: -2, count: 1000 } });
    for (const wrong of ['', ' 1', '0x10', 'Infinity', 'NaN', '1,5', true, [], Number.POSITIVE_INFINITY]) {
      expect(await errors(form, { age: wrong, count: 1 }), String(wrong)).toEqual({ age: [wrong === '' ? 'The age field is required.' : 'The age field must be a number.'] });
    }
    expect(await errors(form, { age: 1, count: '1.5' })).toEqual({ count: ['The count field must be an integer.'] });
  });

  it('booleans: true/false and what forms, URLs and .env say for them; accepted: a ticked box', async () => {
    const form = r.object({ remember: r.boolean(), terms: r.accepted() });
    expect(await check(form, { remember: 'on', terms: 'yes' })).toEqual({ value: { remember: true, terms: true } });
    expect(await check(form, { remember: '0', terms: true })).toEqual({ value: { remember: false, terms: true } });
    expect(await errors(form, { remember: 'maybe', terms: 'no' })).toEqual({ remember: ['The remember field must be true or false.'], terms: ['The terms field must be accepted.'] });
    // An unticked checkbox sends nothing: "must be accepted", not "required".
    expect(await errors(form, { remember: false })).toEqual({ terms: ['The terms field must be accepted.'] });
  });

  it('in, literal, union', async () => {
    const form = r.object({ sort: r.in(['name', '-name']), size: r.in([10, 25]), all: r.literal('all'), limit: r.union([r.literal('all'), r.integer().min(1)]) });
    expect(await check(form, { sort: '-name', size: '25', all: 'all', limit: '5' })).toEqual({ value: { sort: '-name', size: 25, all: 'all', limit: 5 } });
    expect(await errors(form, { sort: 'DROP TABLE', size: '26', all: 'none', limit: 'x' })).toEqual({
      sort: ['The selected sort is invalid.'],
      size: ['The selected size is invalid.'],
      all: ['The selected all is invalid.'],
      limit: ['The limit field is invalid.'],
    });
    // One option took the type: its own message.
    expect(await errors(form, { sort: 'name', size: 10, all: 'all', limit: 0 })).toEqual({ limit: ['The limit field must be at least 1.'] });
    expect(() => r.in([] as never)).toThrow('r.in() needs at least one value.');
  });

  it('objects leave out what their shape does not name; lists check every item', async () => {
    const form = r.object({ tags: r.array(r.string().max(3)), address: r.object({ city: r.string() }) });
    expect(await check(form, { tags: ['a', 'bc'], address: { city: 'Bonn', zip: '53111' }, admin: true })).toEqual({ value: { tags: ['a', 'bc'], address: { city: 'Bonn' } } });
    expect(await errors(form, { tags: 'a', address: 'Bonn' })).toEqual({ tags: ['The tags field must be a list.'], address: ['The address field must be an object.'] });
    expect(await errors(r.string(), 1)).toEqual({ _: ['The value field must be a string.'] });
  });

  it('an object is never a JSON array, at any depth', async () => {
    const message = 'The footer field must be an object.';
    const footer = r.object({ groups: r.array(r.string()).default([]) });
    const form = r.object({ footer });
    for (const array of [[], ['a']]) {
      expect(await errors(form, { footer: array })).toEqual({ footer: [message] });
      expect(await errors(r.object({ footer: footer.optional() }), { footer: array })).toEqual({ footer: [message] });
      expect(await errors(r.object({ footer: footer.nullable() }), { footer: array })).toEqual({ footer: [message] });
      expect(await errors(r.object({ footer: footer.default({ groups: [] }) }), { footer: array })).toEqual({ footer: [message] });
      expect(await errors(r.object({ rows: r.array(footer) }), { rows: [{}, array] })).toEqual({ 'rows.1': ['The rows.1 field must be an object.'] });
      expect(await errors(r.object({ a: r.object({ b: r.object({ c: r.string() }) }) }), { a: { b: array } })).toEqual({ 'a.b': ['The a.b field must be an object.'] });
      expect(await errors(footer, array)).toEqual({ _: ['The value field must be an object.'] });
      expect(await errors(footer, 'x')).toEqual(await errors(footer, array));
    }
    expect(await errors(form, { footer: 'x' })).toEqual({ footer: [message] });
    expect(await check(form, { footer: {} })).toEqual({ value: { footer: { groups: [] } } });
    expect(await check(form, { footer: { groups: ['a'] } })).toEqual({ value: { footer: { groups: ['a'] } } });
  });

  it('a conditional object refuses an array too', async () => {
    const form = r.object({ kind: r.in(['a', 'b']) }).when((v: any) => v.kind === 'a', { extra: r.string().required() } as never);
    expect(await errors(form, [])).toEqual({ _: ['The value field must be an object.'] });
  });
});

describe('the rules of a type', () => {
  it('sizes: characters of a string (code points), the value of a number, items of a list', async () => {
    const form = r.object({ name: r.string().min(2).max(4), age: r.integer().between(18, 99), tags: r.array(r.string()).max(2), pin: r.string().between(4, 4) });
    expect(await check(form, { name: '😀😀😀😀', age: 18, tags: [], pin: '1234' })).toEqual({ value: { name: '😀😀😀😀', age: 18, tags: [], pin: '1234' } });
    expect(await errors(form, { name: 'A', age: 100, tags: ['a', 'b', 'c'], pin: '12' })).toEqual({
      name: ['The name field must be at least 2 characters.'],
      age: ['The age field must be between 18 and 99.'],
      tags: ['The tags field must not have more than 2 items.'],
      pin: ['The pin field must be between 4 and 4 characters.'],
    });
    expect(await errors(r.object({ name: r.string().max(3) }), { name: 'Adam' })).toEqual({ name: ['The name field must not be longer than 3 characters.'] });
    expect(() => r.string().max(Number.NaN)).toThrow('max() takes finite numbers');
  });

  it('trim and lowercase come first; required asks for some text', async () => {
    const form = r.object({ email: r.string().trim().lowercase().required().email(), name: r.string().trim().required() });
    expect(await check(form, { email: '  ADA@Example.COM ', name: ' Ada ' })).toEqual({ value: { email: 'ada@example.com', name: 'Ada' } });
    expect(await errors(form, { email: 'ada', name: '   ' })).toEqual({ email: ['The email field must be a valid email address.'], name: ['The name field is required.'] });
  });

  it('bail: the first problem of a field only — what a form shows next to it', async () => {
    const form = r.object({ name: r.string().trim().required().min(2).max(3).email() });
    expect(await errors(form, { name: ' ' })).toEqual({ name: ['The name field is required.'] });
    expect(await errors(form, { name: 'a' })).toEqual({ name: ['The name field must be at least 2 characters.'] });
  });

  it('url: absolute http(s) only, unless it names other protocols (a javascript: URL in an href runs in every browser)', async () => {
    const link = r.object({ url: r.url() });
    expect(await check(link, { url: 'https://example.com/a?b=c' })).toEqual({ value: { url: 'https://example.com/a?b=c' } });
    for (const wrong of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '/relative', 'https://', 'http://exa mple.com', 'mailto:ada@example.com']) {
      expect(await errors(link, { url: wrong }), wrong).toEqual({ url: ['The url field must be a valid URL.'] });
    }
    expect(await check(r.object({ url: r.url({ protocols: ['https', 'mailto'] }) }), { url: 'mailto:ada@example.com' })).toEqual({ value: { url: 'mailto:ada@example.com' } });
    expect(await errors(r.object({ url: r.url({ protocols: ['https'] }) }), { url: 'http://example.com' })).toEqual({ url: ['The url field must be a valid URL.'] });
  });

  it('uuid, date (a day that exists), isoTimestamp, regex (never stateful)', async () => {
    const form = r.object({ id: r.uuid(), day: r.date(), at: r.isoTimestamp(), code: r.string().regex(/^[A-Z]{3}$/g) });
    const valid = { id: '0199c3e2-7e1c-7a4b-9c1d-1b2c3d4e5f60', day: '2028-02-29', at: '2026-10-07T14:30:00Z', code: 'ABC' };
    expect(await check(form, valid)).toEqual({ value: valid });
    // A `g` pattern would remember where it stopped: every second test of the same value would fail.
    const again = await check(form, valid);
    expect(again.issues, `the second validation of the same value: ${JSON.stringify(again.issues)}`).toBeUndefined();
    expect(await errors(form, { id: 'nope', day: '2026-02-29', at: '2026-10-07 14:30', code: 'abc' })).toEqual({
      id: ['The id field must be a valid UUID.'],
      day: ['The day field must be a valid date.'],
      at: ['The at field must be a valid date and time.'],
      code: ['The code field format is invalid.'],
    });
    expect(await errors(r.object({ code: r.string().regex(/^\d+$/, 'Digits only.') }), { code: 'x' })).toEqual({ code: ['Digits only.'] });
  });
});

describe('what a missing value is', () => {
  it('optional, nullable and default — a missing field, null', async () => {
    const form = r.object({
      bio: r.string().max(5).optional(),
      website: r.url().nullable(),
      tags: r.array(r.string()).default([]),
      page: r.integer().min(1).default(1),
      note: r.string().nullable().default(null),
    });
    expect(await check(form, { website: null })).toEqual({ value: { website: null, tags: [], page: 1, note: null } });
    expect(await check(form, { bio: 'Hi', website: 'https://ada.dev', tags: ['x'], page: '2', note: 'n' })).toEqual({
      value: { bio: 'Hi', website: 'https://ada.dev', tags: ['x'], page: 2, note: 'n' },
    });
    // nullable is not optional: the field must be there (null or a value).
    expect(await errors(form, {})).toEqual({ website: ['The website field is required.'] });
    expect(await errors(form, { website: null, bio: 'far too long' })).toEqual({ bio: ['The bio field must not be longer than 5 characters.'] });
  });
});

describe('an empty string — by type', () => {
  it("a string keeps '' — optional, nullable and default give it back: a subtitle cleared on purpose is no missing one", async () => {
    const block = r.object({
      subtitle: r.string().max(120).optional(),
      caption: r.string().nullable(),
      cta: r.string().default('Read more'),
      trimmed: r.string().trim().optional(),
      plain: r.string(),
    });
    const cleared = await check(block, { subtitle: '', caption: '', cta: '', trimmed: '   ', plain: '' });
    expect(cleared, `'' was taken for missing: ${JSON.stringify(cleared)}`).toEqual({ value: { subtitle: '', caption: '', cta: '', trimmed: '', plain: '' } });
    // Left out it is missing as ever: undefined, the default.
    expect(await check(block, { caption: null, plain: 'x' })).toEqual({ value: { caption: null, cta: 'Read more', plain: 'x' } });
  });

  it("only what asks for text refuses it: required(), min(), a pattern that wants a character", async () => {
    const block = r.object({
      title: r.string().trim().required().optional(),
      short: r.string().min(2).optional(),
      code: r.string().regex(/^[a-z]+$/).optional(),
      slug: r.string().regex(/^[a-z-]*$/).optional(),
    });
    expect(await errors(block, { title: ' ', short: '', code: '', slug: '' })).toEqual({
      title: ['The title field is required.'],
      short: ['The short field must be at least 2 characters.'],
      code: ['The code field format is invalid.'],
    });
    expect(await check(block, { slug: '' })).toEqual({ value: { slug: '' } });
  });

  it("where '' never is a value it is a form's empty field — missing: numbers, booleans, formats, lists, objects, a value of your own", async () => {
    const form = r.object({
      age: r.integer().optional(),
      price: r.number().nullable(),
      newsletter: r.boolean().default(false),
      port: r.port().optional(),
      email: r.string().trim().email().optional(),
      website: r.url().nullable(),
      id: r.uuid().optional(),
      day: r.date().optional(),
      at: r.isoTimestamp().nullable(),
      tags: r.array(r.string()).default([]),
      admins: r.list(r.email()).default([]),
      address: r.object({ city: r.string() }).optional(),
      token: r.value<string>((value) => (typeof value === 'string' && value !== '' ? undefined : 'Choose a file.')).nullable(),
    });
    const empty = Object.fromEntries(['age', 'price', 'newsletter', 'port', 'email', 'website', 'id', 'day', 'at', 'tags', 'admins', 'address', 'token'].map((key) => [key, '']));
    const result = await check(form, empty);
    expect(result.issues?.map((issue) => issue.path?.join('.')), `'' refused where it is missing: ${JSON.stringify(result.issues?.map((issue) => issue.path?.join('.')))}`).toBeUndefined();
    expect(result).toEqual({ value: { age: undefined, price: null, newsletter: false, port: undefined, email: undefined, website: null, id: undefined, day: undefined, at: null, tags: [], admins: [], address: undefined, token: null } });
    // Without a modifier: a type says "required", as for a missing field; a format checks the string (required() first says "required").
    expect(await errors(r.object({ age: r.integer(), email: r.email(), mail: r.string().required().email() }), { age: '', email: '', mail: '' })).toEqual({
      age: ['The age field is required.'],
      email: ['The email field must be a valid email address.'],
      mail: ['The mail field is required.'],
    });
  });

  it("r.in() and r.literal(): '' is a value when it is one of the options — else an empty <select> is missing", async () => {
    const form = r.object({
      align: r.in(['left', 'center']).optional(),
      size: r.in([10, 25]).default(10),
      style: r.in(['', 'bold']).optional(),
      none: r.literal('').optional(),
      plain: r.in(['left', 'center']),
    });
    const result = await check(form, { align: '', size: '', style: '', none: '', plain: 'left' });
    expect(result.issues, `an empty <select> without '' among its options is missing, no error: ${JSON.stringify(result.issues?.map((issue) => issue.message))}`).toBeUndefined();
    expect((result.value as { style?: string } | undefined)?.style, "r.in(['', 'bold']) lost its option ''").toBe('');
    expect(result).toEqual({ value: { align: undefined, size: 10, style: '', none: '', plain: 'left' } });
    expect(await errors(form, { plain: '' })).toEqual({ plain: ['The plain field is required.'] });
  });

  it("r.union(): '' is a value when one of its rules takes it", async () => {
    const form = r.object({ limit: r.union([r.literal('all'), r.integer()]).optional(), label: r.union([r.integer(), r.string()]).optional() });
    const result = await check(form, { limit: '', label: '' });
    expect((result.value as { label?: string } | undefined)?.label, "a union with r.string() lost ''").toBe('');
    expect(result).toEqual({ value: { limit: undefined, label: '' } });
  });

  it("r.query(): a URL's empty field follows the type, like a form's (?q= is '', ?page= the default)", async () => {
    const query = r.query({ q: r.string().trim().optional(), page: r.integer().min(1).default(1), sort: r.in(['name', '-name']).default('name') });
    const parsed = await parseQuery(query, new URLSearchParams('q=&page=&sort='));
    expect(parsed.value).toEqual({ q: '', page: 1, sort: 'name' });
    expect(parsed.dropped).toEqual([]);
  });
});

describe('what a missing value is — the rest', () => {
  it('a default list or object is a copy each time — nobody shares it', async () => {
    const form = r.object({ tags: r.array(r.string()).default([]) });
    const first = (await check(form, {})).value as { tags: string[] };
    first.tags.push('changed by a handler');
    const second = (await check(form, {})).value as { tags: string[] };
    expect(second.tags, `the next validation's default: ${JSON.stringify(second.tags)}`).toEqual([]);
  });

  it('transform: what a valid value becomes — after the rules, an async one too', async () => {
    const words = r.object({ tags: r.string().trim().transform((text) => text.split(/\s+/)) });
    expect(await check(words, { tags: ' a  b ' })).toEqual({ value: { tags: ['a', 'b'] } });
    const counted = r.object({ name: r.string().transform(async (text) => text.length) });
    expect(counted['~standard'].validate({ name: 'Ada' })).toBeInstanceOf(Promise);
    expect(await check(counted, { name: 'Ada' })).toEqual({ value: { name: 3 } });
  });
});

describe('objects', () => {
  it('nested paths (users.1.email) — the issues carry their path and field in the message', async () => {
    const form = r.object({ users: r.array(r.object({ email: r.email() })), address: r.object({ city: r.string().required() }) });
    const result = await check(form, { users: [{ email: 'ada@example.com' }, { email: 'nope' }], address: { city: '' } });
    expect(result.issues?.map((issue) => issue.path)).toEqual([['users', 1, 'email'], ['address', 'city']]);
    expect(result.issues?.map((issue) => issue.message)).toEqual(['The users.1.email field must be a valid email address.', 'The address.city field is required.']);
  });

  it('when: fields checked only while their condition holds — else left out — alongside the other fields\' problems', async () => {
    const form = r
      .object({ kind: r.in(['person', 'company']), name: r.string().required() })
      .when((data) => data.kind === 'company', { vat: r.string().trim().required(), size: r.integer().optional() });
    expect(await check(form, { kind: 'person', name: 'Ada', vat: 'DE1' })).toEqual({ value: { kind: 'person', name: 'Ada' } });
    expect(await check(form, { kind: 'company', name: 'Ada', vat: ' DE1 ', size: '3' })).toEqual({ value: { kind: 'company', name: 'Ada', vat: 'DE1', size: 3 } });
    expect(await errors(form, { kind: 'company', name: '' })).toEqual({ name: ['The name field is required.'], vat: ['The vat field is required.'] });
    // A condition over a field that is not valid does not hold.
    expect(await errors(form, { kind: 'other', name: 'Ada' })).toEqual({ kind: ['The selected kind is invalid.'] });
  });

  it('confirmed: on the confirmation field, once the field itself is valid', async () => {
    const form = r.object({ password: r.string().min(8), password_confirmation: r.string() }).confirmed('password');
    expect(await check(form, { password: 'correct horse', password_confirmation: 'correct horse' })).toEqual({
      value: { password: 'correct horse', password_confirmation: 'correct horse' },
    });
    expect(await errors(form, { password: 'correct horse', password_confirmation: 'correct hose' })).toEqual({ password_confirmation: ['The password confirmation does not match.'] });
    expect(await errors(form, { password: 'short', password_confirmation: 'other' })).toEqual({ password: ['The password field must be at least 8 characters.'] });
    expect(await errors(r.object({ email: r.email() }).confirmed('email', 'email_again'), { email: 'a@b.io' })).toEqual({ email_again: ['The email again does not match.'] });
  });

  it('entries: the fields, a rule each — spread into another object', async () => {
    const page = r.query({ page: r.integer().min(1).default(1) });
    const list = r.query({ ...page.entries, q: r.string().default('') });
    expect(Object.keys(page.entries)).toEqual(['page']);
    expect(await check(list, { page: '2' })).toEqual({ value: { page: 2, q: '' } });
    expect(Object.keys(r.object({ a: r.string() }).confirmed('a').custom(() => true).entries)).toEqual(['a']);
  });

  it('an object\'s custom(): a message under _, or at the field of its choice — only once every field is valid', async () => {
    const event = r.object({ starts_at: r.string(), ends_at: r.string() });
    const ordered = (data: { starts_at: string; ends_at: string }) => data.ends_at >= data.starts_at;
    const form = event.custom(ordered, 'The end comes before the start.');
    const at = event.custom(ordered, { message: 'The end comes before the start.', field: 'ends_at' });
    const reversed = { starts_at: '2026-02-01', ends_at: '2026-01-01' };
    expect(await errors(form, reversed)).toEqual({ _: ['The end comes before the start.'] });
    expect(await errors(at, reversed)).toEqual({ ends_at: ['The end comes before the start.'] });
    expect(await errors(event.custom(ordered, { field: 'ends_at' }), reversed)).toEqual({ ends_at: ['The ends at field is invalid.'] });
    expect(await errors(at, { starts_at: '2026-01-01', ends_at: '2026-02-01' })).toEqual({});
    // A field that is not valid: the check does not run.
    expect(await errors(at, { ends_at: '2026-01-01' })).toEqual({ starts_at: ['The starts at field is required.'] });
    // Nested: the path of the object comes first; an async check and a field of when() work the same.
    const nested = r.object({ event: at.custom(async () => 'Never.', { field: 'starts_at' }) });
    // The first failing check answers, as in a pipeline.
    expect(await errors(nested, { event: reversed })).toEqual({ 'event.ends_at': ['The end comes before the start.'] });
    expect(await errors(nested, { event: { starts_at: '2026-01-01', ends_at: '2026-01-02' } })).toEqual({ 'event.starts_at': ['Never.'] });
    const conditional = r.object({ kind: r.in(['a', 'b']) }).when((data) => data.kind === 'b', { vat: r.string() }).custom(() => 'No.', { field: 'vat' });
    expect(await errors(conditional, { kind: 'a' })).toEqual({ vat: ['No.'] });
  });

  it('r.object() takes rules only', () => {
    expect(() => r.object({ name: { '~standard': {} } as never })).toThrow("Field 'name' is no rule of @marmeon/validation");
  });
});

describe('custom rules', () => {
  it('false is the rule\'s message, a string its own (a key or a text), anything else valid', async () => {
    const form = r.object({
      even: r.integer().custom((value) => value % 2 === 0),
      code: r.string().custom((value) => (value === 'ok' ? undefined : 'codes.unknown')),
      named: r.string().custom((value) => value !== 'x', 'No x.'),
      object: r.string().custom({ validate: (value: string) => value.length < 3 }),
    });
    expect(await check(form, { even: 2, code: 'ok', named: 'y', object: 'ab' })).toEqual({ value: { even: 2, code: 'ok', named: 'y', object: 'ab' } });
    expect(await errors(form, { even: 3, code: 'no', named: 'x', object: 'abc' })).toEqual({
      even: ['The even field is invalid.'],
      code: ['codes.unknown'],
      named: ['No x.'],
      object: ['The object field is invalid.'],
    });
  });

  it('an async check makes the rule async — never skipped in silence; a sync function that returns a Promise is an error', async () => {
    const form = r.object({ code: r.string().custom(async (value) => value === 'ok') });
    const answer = form['~standard'].validate({ code: 'no' });
    expect(answer).toBeInstanceOf(Promise);
    expect(await errors(form, { code: 'no' })).toEqual({ code: ['The code field is invalid.'] });
    const sneaky = r.object({ code: r.string().custom((value) => Promise.resolve(value === 'ok') as never) });
    expect(() => sneaky['~standard'].validate({ code: 'no' })).toThrow('A .custom() check returned a Promise — write it as an async function');
  });

  it('a message may be a function — what translatable() of the router makes: a key with the rule\'s parameters', async () => {
    const form = r.object({ code: r.string().custom((value) => value.length >= 4, translatable('codes.short', { min: 4 }, 'At least {min}.')) });
    expect(await errors(form, { code: 'ab' })).toEqual({ code: ['At least 4.'] });
  });

  it('r.value(): a type of your own — the check runs for a missing value too and names its message; meta rides along', async () => {
    const MARK = Symbol('mark');
    class Upload {}
    const file = r.value<Upload, string | null>((value) => (value instanceof Upload ? undefined : value == null ? 'Choose a file.' : 'Not a file.'), { meta: { [MARK]: 'file' } });
    const form = r.object({ file, other: file.nullable() });
    const upload = new Upload();
    expect(await check(form, { file: upload, other: null })).toEqual({ value: { file: upload, other: null } });
    expect(await errors(form, { other: 'x' })).toEqual({ file: ['Choose a file.'], other: ['Not a file.'] });
    // Every rule made from it keeps the mark: the modifiers, custom(), transform(), live().
    for (const rule of [file, file.nullable(), file.optional(), file.custom(() => true), file.transform((value) => value), file.live()]) expect(metaOf(rule, MARK)).toBe('file');
    expect(metaOf(r.string(), MARK)).toBeUndefined();
    expect(metaOf({ '~standard': {} }, MARK)).toBeUndefined();
    expect(() => r.value(() => Promise.resolve(undefined) as never)['~standard'].validate(1)).toThrow('An r.value() check returned a Promise');
  });

  it('a rule without an async part stays synchronous (jobs and stored notifications need that)', () => {
    const job = r.object({ userId: r.integer(), at: r.isoTimestamp(), tags: r.array(r.string()).default([]) });
    expect(job['~standard'].validate({ userId: 1, at: '2026-10-07T10:00:00Z' })).toEqual({ value: { userId: 1, at: '2026-10-07T10:00:00Z', tags: [] } });
  });
});

describe('queries', () => {
  const query = r.query({ q: r.string().trim().max(60).default(''), sort: r.in(['name', '-name']).default('name'), page: r.integer().min(1).default(1), per_page: r.in([10, 25, 50]).default(10), mine: r.boolean().default(false), tag: r.array(r.string()).default([]) });

  it('strings in, typed values out; an invalid field falls back to its default — never a 422', async () => {
    const parsed = await parseQuery(query, new URLSearchParams('page=3&per_page=25&mine=on&tag=a&q=+Ada+'));
    expect(parsed.value).toEqual({ q: 'Ada', sort: 'name', page: 3, per_page: 25, mine: true, tag: ['a'] });
    const fallen = await parseQuery(query, new URLSearchParams('page=x&per_page=100000&sort=DROP+TABLE&page_size=9'));
    expect(fallen.value).toEqual({ q: '', sort: 'name', page: 1, per_page: 10, mine: false, tag: [] });
    expect([...fallen.dropped].sort()).toEqual(['page', 'page_size', 'per_page', 'sort']);
    expect((await parseQuery(query, new URLSearchParams('page='))).value).toMatchObject({ page: 1 });
  });

  it('every field falls back on its own: default() makes the query total', async () => {
    const fallback = await parseQuery(query, new URLSearchParams('page=0'));
    expect(fallback.value.page).toBe(1);
    expect(fallback.dropped).toEqual(['page']);
    expect(await check(query, {})).toEqual({ value: { q: '', sort: 'name', page: 1, per_page: 10, mine: false, tag: [] } });
  });
});

describe('Standard Schema', () => {
  it('every rule is one: vendor marmeon, version 1', () => {
    const rule: Rule<string> = r.string();
    expect(rule['~standard']).toMatchObject({ version: 1, vendor: 'marmeon' });
    expect(typeof rule['~standard'].validate).toBe('function');
  });

  it('a rule is immutable: every method returns a new one', async () => {
    const name = r.string();
    const short = name.max(2);
    expect(await check(name, 'Ada')).toEqual({ value: 'Ada' });
    expect(await errors(short, 'Ada')).toEqual({ _: ['The value field must not be longer than 2 characters.'] });
  });
});

describe('contentsOf — the rules inside a rule', () => {
  const item = r.string();

  it('names an object’s fields, a list’s item, a union’s options and what a modifier wraps', () => {
    expect(contentsOf(r.object({ a: item }))).toMatchObject({ kind: 'object', fields: { a: item } });
    expect(contentsOf(r.array(item))).toEqual({ kind: 'list', item });
    expect(contentsOf(r.list(item))).toEqual({ kind: 'list', item });
    expect(contentsOf(r.union([item, r.literal('x')]))).toMatchObject({ kind: 'union', options: [item, expect.anything()] });
    const object = r.object({ a: item });
    for (const wrapped of [object.optional(), object.nullable(), object.default({ a: '' })]) expect(contentsOf(wrapped)).toEqual({ kind: 'modified', rule: object });
  });

  it('survives custom() and transform(), and is nothing for a rule without others inside', () => {
    expect(contentsOf(r.object({ a: item }).custom(() => true))).toMatchObject({ kind: 'object' });
    expect(contentsOf(r.array(item).transform((list) => list.length))).toMatchObject({ kind: 'list' });
    expect(contentsOf(item)).toBeUndefined();
    expect(contentsOf({ '~standard': {} })).toBeUndefined();
  });
});
