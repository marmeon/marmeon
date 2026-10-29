import type { MessageTranslator } from '@marmeon/router';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { rules as r, validate } from './index.ts';

const german: Record<string, string> = {
  'marmeon.validation.required': 'Das Feld {attribute} ist erforderlich.',
  'marmeon.validation.email': 'Das Feld {attribute} muss eine gültige E-Mail-Adresse sein.',
};
const translator: MessageTranslator = {
  has: (key) => Object.hasOwn(german, key),
  text: (key, params = {}, fallback) => (german[key] ?? fallback ?? key).replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)),
};

const row = r.object({ name: r.string().trim().required(), email: r.string().email().required() });

/** A repository as @marmeon/database's: `query()` gives a Kysely-like builder. */
class UserRepository {
  query() {
    const rows: Record<string, unknown>[] = [{ email: 'ada@example.com' }];
    const where: [string, unknown][] = [];
    const query = {
      select: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        where.push([column, value]);
        return query;
      },
      limit: () => query,
      executeTakeFirst: () => Promise.resolve(rows.find((candidate) => where.every(([column, value]) => candidate[column] === value))),
    };
    return query;
  }
}

describe('validate()', () => {
  it('a valid value is an ok with the rules\' output', async () => {
    const result = await validate(row, { name: '  Ada ', email: 'ada@example.com' });
    expect(result).toEqual({ ok: true, value: { name: 'Ada', email: 'ada@example.com' } });
    if (result.ok) {
      const name: string = result.value.name;
      expect(name).toBe('Ada');
    }
    // @ts-expect-error the output has no such field
    if (result.ok) void result.value.missing;
  });

  it('an invalid value is an err with the messages by field', async () => {
    expect(await validate(row, { name: '', email: 'nope' })).toEqual({
      ok: false,
      error: { kind: 'invalid', errors: { name: ['The name field is required.'], email: ['The email field must be a valid email address.'] } },
    });
  });

  it('the messages in the translator\'s language, with the attributes and messages a request would have', async () => {
    const result = await validate(row, { name: '', email: 'nope' }, { translator, attributes: { email: 'E-Mail' } });
    expect(result.ok ? undefined : result.error.errors).toEqual({
      name: ['Das Feld name ist erforderlich.'],
      email: ['Das Feld E-Mail muss eine gültige E-Mail-Adresse sein.'],
    });
    const own = await validate(row, { name: '', email: 'ada@example.com' }, { messages: { required: 'Fill in {attribute}.' } });
    expect(own.ok ? undefined : own.error.errors).toEqual({ name: ['Fill in name.'] });
  });

  it('exists() asks the repository resolve builds; without resolve it throws and names validate()', async () => {
    const schema = r.object({ email: r.string().required().exists(UserRepository, 'email' as never) });
    const resolve = <T>(Class: new (...args: any[]) => T): T => new Class();
    expect(await validate(schema, { email: 'ada@example.com' }, { resolve })).toMatchObject({ ok: true });
    const missing = await validate(schema, { email: 'none@example.com' }, { resolve });
    expect(missing.ok).toBe(false);
    await expect(validate(schema, { email: 'ada@example.com' })).rejects.toThrow(/validate\(schema, value, \{ resolve \}\)/);
  });

  it('a rule that reads ctx fails closed: a fallback for a missing ctx never drops its filter', async () => {
    const resolve = <T>(Class: new (...args: any[]) => T): T => new Class();
    const strict = r.object({ email: r.string().required().exists(UserRepository, 'email' as never, { where: (query, ctx: any) => query.where('team_id', '=', ctx.user.team_id) }) });
    const fallback = r.object({ email: r.string().required().exists(UserRepository, 'email' as never, { where: (query, ctx: any) => (ctx ? query.where('team_id', '=', ctx.user.team_id) : query) }) });
    for (const schema of [strict, fallback]) {
      await expect(validate(schema, { email: 'ada@example.com' }, { resolve })).rejects.toThrow(/validate\(\) has no request/);
    }
  });

  it('a schema of another library', async () => {
    const schema = v.object({ age: v.pipe(v.number(), v.minValue(18, 'Too young.')) });
    expect(await validate(schema, { age: 20 })).toEqual({ ok: true, value: { age: 20 } });
    expect(await validate(schema, { age: 3 })).toEqual({ ok: false, error: { kind: 'invalid', errors: { age: ['Too young.'] } } });
  });
});
