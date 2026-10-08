# @marmeon/validation

Laravel's validation rules, typed (E197): `rules` builds the schemas of requests, queries, configs and jobs with the names Laravel
apps know — `required`, `max`, `email`, `in`, `unique`, `confirmed` … — and every rule is a **Standard Schema** object, so whatever
takes a schema in Marmeon takes one: `defineRequest`, `parseQuery`, `defineConfig`, a job's `static schema`. Messages come in the
request's language (English and German ship in [@marmeon/i18n](../i18n/README.md)), the first problem of a field only, with the
field's name in them. Database rules get their repository from the request — and never answer a live validation unless they say so.
The guide [validation](../../docs/validation.md) puts it together — from a request to its handler, why database rules never run live,
other libraries, and the way over from Valibot.

```ts
import { rules as r } from '@marmeon/validation';
import { defineRequest } from '@marmeon/http';

export const UpdateProfileRequest = defineRequest({
  schema: r.object({
    name:    r.string().trim().required().max(255),
    email:   r.string().trim().lowercase().required().email().max(255)
               .unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),   // async, from the request — never live (E197)
    website: r.url().nullable(),
    tags:    r.array(r.string().max(30)).max(10).default([]),
  }),
  messages:   { 'email.unique': 'profile.validation.email_taken' },   // translation keys (or texts), Laravel's messages()
  attributes: { email: 'profile.fields.email' },                     // the field's name in messages, Laravel's attributes()
});
// ctx.body: { name: string; email: string; website: string | null; tags: string[] }
// FormOf:   { name: string; email: string; website: string | null; tags?: string[] }   — what the browser sends

export const ListPeopleRequest = defineRequest({
  query: r.query({ sort: r.in(['name', '-name']).default('name'), page: r.integer().min(1).default(1) }),   // strings in, total (E56)
});

export const AppConfig = defineConfig('app', {
  env: r.env({ APP_PORT: r.port().default(3960), INVITES: r.boolean().default(false), ADMINS: r.list(r.email()).default([]) }),
  resolve: (env) => env,   // { APP_PORT: number; INVITES: boolean; ADMINS: string[] }
});
```

```text
de: „Das Feld E-Mail darf höchstens 255 Zeichen haben."   (key marmeon.validation.max.string, parameters { attribute, max })
en: "The email field must not be longer than 255 characters."
```

**Dependencies** ([the driver rule, E198](../../CONTRIBUTING.md#dependencies-of-drivers)): Valibot is the engine under the rules — a
dependency of this package, **never re-exported**: no type of this package names it, so an app installs nothing for its validation and
an app's `.d.ts` never needs it (TS2742). A Valibot release is this package's business, not the app's. Server code only: the browser
imports types of a request (`FormOf`), never a rule (a test of the web app's client build keeps it that way).

## The rules

| Rule | Takes | Gives |
|---|---|---|
| `r.string()` | a string — never one with a NUL character | `string` |
| `r.number()`, `r.integer()` | a number, or a string that spells one in decimal (`'42'`, `'-1.5'`) | `number` |
| `r.boolean()` | `true`/`false`, `1`/`0`, `'on'`/`'off'`, `'yes'`/`'no'`, `'true'`/`'false'` | `boolean` |
| `r.accepted()` | a ticked checkbox: `true`, `'on'`, `'yes'`, `'1'` … — missing is "must be accepted" | `true` |
| `r.in([...])` | one of the values — a number also as a form spells it (`'25'`) | the value |
| `r.literal(value)` | exactly `value` | the value |
| `r.union([a, b])` | what the first rule that takes it takes | either output |
| `r.object({...})` | an object — fields the shape does not name are left out | the fields' outputs |
| `r.array(rule)` | a list, each item checked by `rule` | a list |
| `r.email()`, `r.url()`, `r.uuid()`, `r.date()`, `r.isoTimestamp()` | `r.string()` with that rule | `string` |
| `r.query({...})`, `r.env({...})`, `r.port()`, `r.list(rule)` | see [Queries](#queries) and [Environment variables](#environment-variables) | |
| `r.value<Output, Input>(check, { meta })` | what `check` passes — see [A type of your own](#a-type-of-your-own-rvalue) | the value |

What a rule of a type adds — in order, each after the one before (`trim()` before `required()`):

- **strings:** `trim()`, `lowercase()`, `required()` (not empty — Laravel's `required`), `min(n)`, `max(n)`, `between(min, max)`
  (characters — code points, as Postgres counts them), `email()`, `url({ protocols })`, `uuid()`, `regex(pattern, message?)`,
  `date()` (`2026-10-07`, a day that exists), `isoTimestamp()`;
- **numbers:** `integer()` (a safe integer), `min(n)`, `max(n)`, `between(min, max)`;
- **lists:** `required()` (not empty), `min(n)`, `max(n)`, `between(min, max)` (items);
- **objects:** `when(condition, fields)`, `confirmed(field, confirmation?)`, `entries` (the fields) — see [Objects](#objects);
- **every rule:** `transform(fn)`, `custom(check, message?)`, `unique(…)`, `exists(…)`, `live()`, and the modifiers below.

`r.url()` takes **absolute http and https URLs only** unless `protocols` names others (`r.url({ protocols: ['https', 'mailto'] })`): a
`javascript:` URL in an `href` runs in every visitor's browser. A `regex()` pattern loses its `g` and `y` flags (they make `test()`
remember where it stopped). The catalogue is what apps use plus the Laravel classics they miss — not all of Laravel's 90 rules;
`custom()` covers the rest.

A rule is **immutable**: every method returns a new one, so a shared `const email = r.email().max(255)` can be extended anywhere.

### Missing values: `optional()`, `nullable()`, `default()`

They come **last** — after them, the type's rules are gone from the API (`r.string().optional().max(3)` does not compile:
"Property 'max' does not exist on type 'Rule<string | undefined, string | undefined>'"):

- `optional()` — the field may be missing: `bio?: string` in both the input and the output;
- `nullable()` — the field may be `null` (but must be there): `website: string | null`;
- `default(value)` — what a missing field becomes: always there in the output (`page: number`), optional in the input; a list or object
  default is copied for every validation, so nobody shares it.

**An empty string — by type (E208).** Where `''` can be a value of the rule, the modifiers keep it: `r.string()` (with `trim()`,
`max()` …) and an `r.in([…])` that lists `''` — a page builder's subtitle cleared on purpose arrives as `''`, neither missing nor an
error; `required()`, `min(n)` or a pattern that wants a character still refuse it. Where `''` never is a value — numbers, booleans,
`email()`/`url()`/`uuid()`/`date()`/`isoTimestamp()`, an `r.in()` without `''`, lists, objects, `r.value()` — it is a form's empty
field and counts as missing: `null` for a nullable rule without a default, else the default or `undefined` (without a modifier:
"required"). Queries follow the same rule; in `r.env()` every empty variable is missing. The table, the reasons and the way back
(`.transform((text) => (text === '' ? undefined : text))`): the guide's
[empty strings](../../docs/validation.md#empty-strings-a-value-or-missing--by-type).

### Types: input and output

A rule has two types — what it takes and what it gives — and the router's helpers read them: `FormOf<typeof Controller>` is the
input (what a form sends, `useForm` types its fields with it), `ctx.body` and `QueryOf<typeof Controller>` the output, and
`ConfigOf<typeof AppConfig>` what `resolve` makes of the output. `optional()`, `nullable()`, `default()` and `transform()` change them:

```ts
r.integer()                         // input number | `${number}`, output number
r.integer().nullable()              // input number | `${number}` | null, output number | null
r.boolean().default(false)          // input BooleanInput | undefined, output boolean
r.string().trim().transform((text) => text.split(' '))   // input string, output string[]
```

## Messages

Every rule's message has a key — `marmeon.validation.<rule>[.<type>]`: `required`, `string`, `max.string`, `max.number`,
`max.array`, `email`, `unique` … — and the rule's parameters (`attribute`, `min`, `max`). The request's translator shows it in the
request's language ([@marmeon/i18n](../i18n/README.md) has English and German for every rule); without @marmeon/i18n the message is
English (`VALIDATION_TEXTS`, the same texts).

- **`{attribute}`** is the field: its path with underscores as spaces (`password_confirmation` → "password confirmation",
  `users.1.email`), Laravel's rule — or the request's **`attributes`**: `{ email: 'profile.fields.email' }` (a translation key, or a
  text; `'links.*.url'` — `*` is one segment).
- **`messages`** replace the framework's message of a rule: `{ 'email.unique': 'profile.validation.email_taken' }` for one field,
  `{ required: 'Fill this in.' }` for every field — `<field>.<rule>` wins. The rule is the part after `marmeon.validation.` (`max` for
  `max.string`). A message may use the rule's placeholders: `'Keep {attribute} under {max}.'`.
- **The first problem of a field only** (Laravel's `bail`, as a default): a form shows one message per field, so the rules after the
  first failing one do not run — `r.string().trim().required().email()` says "required" for `' '`, never also "must be a valid email".
- `regex(pattern, message)`, `custom(check, message)` and `unique(…, { message })` take a message of their own: a key, a text, or a
  message function — what `translatable(key, params, english)` of the router (and `trans()` of [@marmeon/i18n](../i18n/README.md))
  makes, for a key with parameters: `.custom(isLongEnough, translatable('teams.validation.slug_min', { min: 3 }, 'At least {min}.'))`.

A request's `messages`/`attributes` are `defineRequest` options of [@marmeon/router](../router/README.md#controllers-and-requests); they
reach a live validation's errors too.

## Queries

`r.query({ … })` is an object of fields read from the URL (E55/E56): strings — `r.integer()`, `r.boolean()` and `r.in([10, 25])` take
their spelling — where **every field has a default** (or is `optional()`): `parseQuery` lets an invalid field fall back to it, and a URL
never answers 422. A field without one does not compile, and the message says why:

```text
Type 'NumberRule' is not assignable to type '"Query field 'page' needs .default(…) — a query is parsed field by field and never
answers 422 (E56); .optional() leaves it undefined"'.
```

A field that cannot come from a URL (`r.object()`) is refused the same way ("Query field 'address' is read from the URL as text — …").
`r.array(rule)` takes a repeated key (`?tag=a&tag=b`) and one value as a list of one (`?tag=a`).

## Environment variables

`r.env({ … })` is the `env` of a [`defineConfig`](../core/README.md): every variable is a string, read like a query — `r.integer()`,
`r.boolean()`, `r.port()` (1–65535) and `r.list(rule)` (`ADMINS=ada@example.com, alan@example.com` → a list, each item checked) take
them; an empty variable (`APP_PORT=`, `S3_BUCKET=`) is missing — whatever its rule, `r.string()` too (a form keeps `''`, E208).
Messages name the variable as it is written (`APP_PORT`, not "app port"):

```text
Invalid configuration — the application cannot start:
  • app: APP_PORT — The APP_PORT field must be a port number from 1 to 65535.
  • app: ADMINS.1 — The ADMINS.1 field must be a valid email address.
Set these variables in the environment or in .env (see .env.example).
```

A rule that cannot read a string (`r.array()` — `r.list()` does) does not compile ("Environment variable 'TAGS' is text — …").

## Objects

- **`when(condition, fields)`** — fields checked only while `condition` holds for the object's other fields (Laravel's
  `sometimes`/`required_if`), left out otherwise; optional in the output type. Checked alongside the other fields, not after them:

  ```ts
  r.object({ kind: r.in(['person', 'company']), name: r.string().required() })
    .when((data) => data.kind === 'company', { vat: r.string().trim().required() })
  ```

- **`confirmed(field, confirmation = '<field>_confirmation')`** — the confirmation repeats the field (as typed), reported on the
  confirmation field once the field itself is valid: "The password confirmation does not match." (key `marmeon.validation.confirmed`).
  A new password is `password()` of [@marmeon/auth](../auth/README.md#validation-rules) — a rule too:
  `r.object({ password: password(), password_confirmation: r.string() }).confirmed('password')`.
- **`entries`** — the fields, a rule each (not those of `when()`): spread one object's fields into another,
  `r.query({ ...MembersTable.query.entries, tab: r.in(['all', 'mine']).default('all') })`.
- Issues of nested fields have their full path — `users.1.email`, `address.city` — which is what a form's errors and a live
  validation's fields use.

## Custom rules

`custom(check, message?)` is Laravel's `ValidationRule`: the check gets the value (the output so far) and `{ request }` (the request's
`resolve`, `ctx` and whether it is live — undefined outside a request) and answers `false` (the message: `message`, else "The … field is
invalid."), a message of its own (a translation key or a text), or nothing for a valid value. An object with a `validate` method works
too.

```ts
code: r.string().custom(async (code, { request }) => (await request!.resolve(Invites).valid(code)) || 'invites.validation.unknown'),
```

An **async** check (an `async` function) makes the rule async — and, like the database rules, it does not run in a live validation
unless the rule says `.live()`. A check that returns a Promise without being an `async` function is an error, never skipped in silence.
A rule without an async part stays **synchronous** (a stored notification's `static database` needs that).

## A type of your own: `r.value()`

`r.value<Output, Input>(check, { meta })` is a rule for a value no other rule describes — what a package brings (an upload of
[@marmeon/storage](../storage/README.md#uploads)) or what only a check can say: `check` gets the value — a missing one too
(`undefined`), so it says what missing means — and answers with a message (a key, a text, `translatable()`'s) or nothing; the value
is taken as it is. It is synchronous (an async check: `.custom()` after it) and has every rule's methods (`.nullable()`,
`.custom()`, `.transform()` …).

```ts
const slug = r.value<string>((value) => (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? undefined : 'teams.validation.slug'));
```

`meta` marks the rule — `{ [UPLOAD_RULE]: { maxBytes, mime } }` — and every rule made from it keeps the mark; `metaOf(rule, key)`
reads it (undefined for anything else, another library's schema too). That is how the upload target and the submit find an upload
field in a body schema, through `upload(…).nullable()` as well.

## Database rules and live validation

- **`unique(Repository, column, { ignore?, ignoreColumn?, where?, message? })`** — the value is in no row of the repository's table yet.
  `ignore: (ctx) => ctx.user.id` leaves out the row being edited (`ignoreColumn`, default `id`); `where: (query, ctx) => query.where(…)`
  narrows the rows that count (a tenant). Soft-deleted rows count: the unique index holds them too.
- **`exists(Repository, column, { where?, message? })`** — the value is in a row (soft-deleted rows are not).
- The repository comes from the **request** — the router hands every schema its `resolve` (`libraryOptions.marmeon`) — so no
  `schema: (resolve) => …` factory is needed. `column` is typed from the repository's rows. Outside a request (a config, a job) a
  database rule says so instead of guessing.
- **Never live (E187/E193/E197).** A live validation (E62) checks a field while it is being typed; a `unique` there would tell anyone who
  types an address whether it has an account — in the background, without a submit, without a throttle that notices. So database rules
  and async `custom()` rules **do not run in a live validation**: a free and a taken value get the same answer there, and the submit
  tells (where the throttle and the request's own rules apply). A schema of **another library** does not run live at all unless its
  request says `live: true` (E206, fail-closed — the router cannot see its checks). Inside such a schema that calls ours without the
  request, a `unique`/`exists` throws (it needs the request — a 500, on submit too: put the whole object into `rules`), and an async
  `custom()` that ran is dropped by its mark (`NOT_LIVE`) — the second measure.
- **`.live()` goes on the field** — a rule of one value — and opts it in, for values whose being taken is no secret (a team's slug in
  its own settings); never for anything that tells whether an account exists. On an object, a list or a union it is a compile error
  and throws (`r.object({ … }).live()` would open every rule inside — the address next to the slug): `r.object({ slug:
  r.string().unique(Teams, 'slug').live() })`. Registration has no `unique` at all (private registration, E146/E193).
- **The unique index is the truth.** Two requests can race past `unique`; `failOnDuplicate()` of
  [@marmeon/database](../database/README.md) turns the index's conflict into the same 422 at the field — in the handler, where the
  router lends the error the request's `messages` and `attributes` (the same text as the rule's).

## Other libraries

Standard Schema stays the contract (E197): Zod, Valibot, ArkType or any other library's schemas work wherever a rule does — the app
installs that library itself. Only a live validation leaves them out: it answers `204` without running one, unless the request says
`live: true` (E206). `rules` is what the docs, the starter kit and the generators use. A rule is a Standard Schema object with
the vendor `marmeon`; its issues have plain paths (`['users', 1, 'email']`) and finished messages, so any consumer of Standard Schema
reads them. `r.object()` takes rules only (a field of another library: wrap the whole object in that library instead).
