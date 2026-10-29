# Validation

## Introduction

Every input of an app passes a schema: a form's body, a URL's query, a job's payload.
The framework writes its schemas with `rules` of `@marmeon/validation`. The rules carry familiar names such as `required`, `max`,
`email`, `in`, `confirmed` and `unique`, they are typed from end to end, and their messages come in the request's language:

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UpdateNoteRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
    slug: r.string().trim().lowercase().required().max(80).unique(NoteRepository, 'slug', { ignore: (ctx) => ctx.params.note.id }),
    link: r.url().nullable(),
    tags: r.array(r.string().max(30)).max(10).default([]),
  }),
  messages: { 'slug.unique': 'notes.validation.slug_taken' },
  attributes: { slug: 'notes.fields.slug' },
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    // ctx.body: { title: string; slug: string; link: string | null; tags: string[] }: trimmed, lower-cased, filled in
    await this.#notes.update(ctx.params.note.id, { title: ctx.body.title, slug: ctx.body.slug });
    return this.redirect().route('notes.show', { note: ctx.params.note.id });
  }
}
```

Every rule is a [Standard Schema](https://standardschema.dev) object, the common interface of TypeScript validation libraries.
So whatever takes a schema in the framework takes a rule, and a schema of Zod, ArkType or Valibot works in its place.

## From schema to handler

The router runs a request in a fixed order: the middleware, the route's bindings, `authorize`, the query, then the body's schema.
It builds the controller only when everything passed, so `handle()` never sees input that failed its schema. The schema sees the
body and only the body, never the query.

A body that fails answers in one of two ways:

- **A page's form** goes back to where it came from, the `Referer` of this host. The errors and the input are flashed, and the
  page shows the errors next to the fields: the session shares them as the `errors` prop. A request without such a `Referer`,
  say from a browser or policy that strips it, goes to `/`.
- **A JSON client**, and an action of a page, gets a 422 with the errors per field:

```json
{ "message": "The title field is required. (and 1 more error)", "errors": { "title": ["The title field is required."], "link": ["The link field must be a valid URL."] } }
```

A nested field carries its full path: `address.city`, `links.0.url`.

The same rules serve every other place that takes a schema: `query` of a request, `static schema` of a job, and `parseQuery()` by
hand. The rules are server code. A view imports the request's types, never a rule, so no code of
`@marmeon/validation` reaches the browser. An app needs no other validation library: the engine under the rules is the package's
own dependency, and no type of it shows in your code.

## Available rules

```ts
import { rules as r } from '@marmeon/validation';
```

| Rule | Takes | Gives |
| --- | --- | --- |
| `r.string()` | A string, never one with a NUL character. | `string` |
| `r.number()`, `r.integer()` | A number, or a string that spells one in decimal: `'42'`, `'-1.5'`. | `number` |
| `r.boolean()` | `true` and `false`, `1` and `0`, `'on'` and `'off'`, `'yes'` and `'no'`, `'true'` and `'false'`. | `boolean` |
| `r.accepted()` | A ticked checkbox: `true`, `'on'`, `'yes'`, `'1'`. Missing is "must be accepted". | `true` |
| `r.in([...])` | One of the values. A number also as a form spells it: `'25'`. | The value |
| `r.literal(value)` | Exactly `value`. | The value |
| `r.union([a, b])` | What the first rule that takes it takes. | Either output |
| `r.object({...})` | An object. Fields the shape does not name are left out. | The fields' outputs |
| `r.array(rule)` | A list, each item checked by `rule`. | A list |
| `r.email()`, `r.url()`, `r.uuid()`, `r.date()`, `r.isoTimestamp()` | `r.string()` with that check. | `string` |
| `r.localDateTime(zone)` | What `<input type="datetime-local">` sends, `2026-10-07T14:30`, read in `zone`. | An instant, as `string` |
| `r.timeZone()` | A time zone: `Europe/Berlin`, `UTC`, `+02:00`. | `string` |
| `r.query({...})`, `r.port()`, `r.list(rule)` | A URL's fields, a port from 1 to 65535, a comma-separated list. | |
| `r.value<Output, Input>(check)` | What `check` passes: a type of your own. | The value |

Each type then has its checks, which run **in the order you write them**: `trim()` before `required()` makes `' '` missing.

- **Strings:** `trim()`, `lowercase()`, `required()` (not empty), `min(n)`, `max(n)`, `between(min, max)`, `email()`,
  `url({ protocols })`, `uuid()`, `regex(pattern, message?)`, `date()` (a day that exists, `2026-10-07`), `isoTimestamp()`, `timeZone()`. Lengths
  count characters as code points, the way Postgres counts them.
- **Numbers:** `integer()` (a safe integer), `min(n)`, `max(n)`, `between(min, max)`.
- **Lists:** `required()` (not empty), `min(n)`, `max(n)`, `between(min, max)`, counting items.
- **Objects:** `when(condition, fields)`, `confirmed(field)`, and `entries`, the fields.
- **Every rule:** `transform(fn)`, `custom(check, message?)`, `unique(…)`, `exists(…)`, `live()`, and last the modifiers
  `optional()`, `nullable()` and `default(value)`.

A field reports its **first problem only**. The checks after the first one that fails do not run, so a form shows one message per
field: `r.string().trim().required().email()` says "required" for `' '`, never also "must be a valid email address".

A rule is **immutable**. Every method returns a new rule, so a shared `const email = r.email().max(255)` can be extended anywhere
without changing it for the others.

`r.url()` takes absolute `http` and `https` URLs only, since a `javascript:` URL in an `href` runs in every visitor's browser.
`r.url({ protocols: ['https', 'mailto'] })` names others. A `regex()` pattern loses its `g` and `y` flags, which would make it
remember where it stopped between two values.

The catalogue covers what apps use. `custom()` covers the rest.

### Missing values

The modifiers come **last**. After them, the type's checks are gone from the rule, and `r.string().optional().max(3)` does not
compile.

| Modifier | The field | Its type |
| --- | --- | --- |
| `optional()` | May be missing. | `bio?: string`, in input and output. |
| `nullable()` | May be `null`, but must be there. | `link: string \| null` |
| `default(value)` | Becomes `value` when missing. | Optional in the input, always there in the output. |

A list or object default is copied for every validation, so no two requests share it.

### Empty strings: a value or missing — by type

A form sends every field as a string, an empty one as `''`. A JSON client sends `''` on purpose: a subtitle someone cleared must
arrive as `''`, neither as missing, which would keep the old subtitle, nor as an error. So the rules decide by type. Where `''` can
be a value of the rule, it is one. Where it never can, it is a form's empty field and counts as missing.

| Rule | `''` with `optional()`, `nullable()` or `default(v)` | `''` without a modifier |
| --- | --- | --- |
| `r.string()` with `trim()`, `lowercase()`, `max()`, `custom()`, `transform()` | `''`, a value | `''` |
| `r.string()` with `required()`, `min(n)` or a `regex()` that wants a character | The check fails: "required", "at least n characters", "format is invalid". | The same |
| `r.in([…])`, `r.literal(v)` with `''` among the values | `''` | `''` |
| `r.in([…])`, `r.literal(v)` without `''`, such as a select's placeholder | Missing: `undefined`, `null` or `v` | "required" |
| `r.union([…])` | `''` when one of its rules keeps it, else missing | What its rules say |
| `r.number()`, `r.integer()`, `r.port()`, `r.boolean()`, `r.accepted()`, `r.localDateTime()` | Missing | "required", or "must be accepted" |
| `r.email()`, `r.url()`, `r.uuid()`, `r.date()`, `r.isoTimestamp()`, `r.timeZone()` | Missing | The format's message |
| `r.array()`, `r.list()`, `r.object()`, `r.value()`, an upload | Missing | `r.array()` and `r.object()`: "required". `r.list()`: an empty list. `r.value()`: its check. |

```ts
schema: r.object({
  title: r.string().trim().required().max(80),
  subtitle: r.string().trim().max(120).optional(), // '' → '' (cleared on purpose), left out → undefined (unchanged)
  width: r.integer().min(1).optional(), // '' → undefined: an empty number field
  link: r.url().nullable(), // '' → null
  align: r.in(['left', 'center']).default('left'), // '' → 'left': the select's placeholder
}),
```

`trim()` runs inside the rule, after the modifier looked: `'   '` with `r.string().trim().optional()` becomes `''` and is kept, like
a `''` sent as it is. With `required()` it is "required". A form and a JSON client get the same answer.

A query follows the same rules: `?q=` is `''` for `r.string()` and missing for `r.integer()`.

To make `''` missing in a string field, turn it into `undefined` or `null` after the checks:

```ts
subtitle: r.string().trim().max(120).transform((text) => (text === '' ? undefined : text)).optional(), // '' → undefined
caption: r.string().max(200).transform((text) => (text === '' ? null : text)).nullable(), // '' → null
// With a check that '' fails, such as min(2), let '' through first:
nickname: r.union([r.literal(''), r.string().trim().min(2).max(30)]).transform((name) => (name === '' ? undefined : name)).optional(),
```

### Input and output

A rule has two types: what it takes, its **input**, and what it gives, its **output**. The modifiers and `transform()` change
them, and the framework's helpers read them:

```ts
r.integer() // input number | `${number}`, output number
r.integer().nullable() // input number | `${number}` | null, output number | null
r.boolean().default(false) // input BooleanInput | undefined, output boolean
r.string().optional() // input string | undefined, output string | undefined
r.string().trim().transform((text) => text.split(' ')) // input string, output string[]
```

| Helper | Reads | For `UpdateNoteRequest` |
| --- | --- | --- |
| `ctx.body` | The body's output. | `{ title: string; slug: string; link: string \| null; tags: string[] }` |
| `FormOf<UpdateNoteController>` | The body's input: what a form sends. `useForm()` types its fields with it. | `{ title: string; slug: string; link: string \| null; tags?: string[] }` |
| `QueryOf<ListNotesController>` | The parsed query, an output. | `{ sort: 'title' \| '-title'; page: number }` |

A field of `when()` is optional in the output.

## Objects

```ts
schema: r.object({ password: password(), password_confirmation: r.string() }).confirmed('password'),

r.object({ kind: r.in(['person', 'company']), name: r.string().required() })
  .when((data) => data.kind === 'company', { vat: r.string().trim().required() }),
```

- **`confirmed(field, confirmation)`** compares the confirmation, by default `<field>_confirmation`, with the field as typed. It
  reports on the confirmation, "The password confirmation does not match.", once the field itself is valid. A form that gets both
  wrong shows the password's problem first. `password()` of `@marmeon/auth` is the rule for a new password.
- **`when(condition, fields)`** checks the fields while the condition holds for the object's other fields, and leaves them out
  otherwise. They are checked alongside the other fields, not after them.
- **`custom(check, options?)`** checks the object once every field is valid. The check gets the object, so it can compare fields.
  A failed check reports under the key `_`, the errors that belong to the form and no field, and a form shows it with
  `form.errors._`. To report it at one of the fields, where the user can fix it, name the field:
  `r.object({ starts_at, ends_at }).custom((event) => event.ends_at >= event.starts_at, { message: 'The end comes before the start.', field: 'ends_at' })`.
  `message` is a translation key, a text or a message function, as for any `custom()`; `field` is one of the object's fields, also one of
  `when()`. The `custom()` of a single field takes no `field`: it reports at that field. While a field is invalid the check does not run,
  and the first failing check of the object answers.
- **`entries`** are the fields, a rule each, without those of `when()`. Spread them into another object:
  `r.query({ ...MembersTable.query.entries, tab: r.in(['all', 'mine']).default('all') })`.

## A date and time in a zone

`r.localDateTime(zone)` reads what a `datetime-local` field sends, a date and a time without a zone, in the zone of the event, the
user or the venue, and gives the instant as `2026-10-07T12:30:00.000Z`, the way `Date#toISOString()` writes it. The text must have the shape `2026-10-07T14:30`, seconds
optional, and name a day that exists; anything else is "The … field must be a date and time like 2026-10-07T14:30." The `zone` is one of:

- **A name**, `'Europe/Berlin'`. It is checked when the rule is defined, and a wrong one throws a `RangeError`.
- **`{ field }`**, the zone that another field of the same object holds: `r.localDateTime({ field: 'time_zone' })`. The object reads that
  field once it is valid, so put `r.timeZone()` or an `r.in([…])` on it. An unknown zone is reported at the zone field, "The time zone field must be a valid time zone." The rule belongs
  directly in an `r.object()` next to the zone field; anywhere else it refuses to run. The field's own `custom()` and `transform()` see the text as typed, so check the instants in the object's `custom()`.
- **A function** of the request's context, for a zone the request knows: `r.localDateTime((request) => zoneOf(request))`. A function that returns no known zone fails the field with "must be a valid time zone."

The two nights the clock changes have a fixed reading, described on the [time](time.md#a-time-typed-in-a-zone) page. `toLocalDateTime(instant, zone)` goes the other way for an edit form.

## Messages

Every rule's message has a key and parameters: `marmeon.validation.<rule>`, sometimes with the type, such as `required`,
`max.string`, `max.number`, `max.array`, `email` or `unique`, with parameters such as `attribute`, `min` and `max`. The request's
translator shows it in the request's language. The localization package ships English and German for every rule. Without it, the
messages are English.

```text
en  The email field must not be longer than 255 characters.    marmeon.validation.max.string  { attribute: 'email', max: 255 }
de  Das Feld E-Mail darf höchstens 255 Zeichen haben.          with attributes: { email: 'profile.fields.email' } → "E-Mail"
en  The password confirmation does not match.                  marmeon.validation.confirmed, on password_confirmation
de  Der Wert für E-Mail ist bereits vergeben.                  marmeon.validation.unique
```

- **`{attribute}`** is the field: its path with underscores as spaces, so `password_confirmation` is "password confirmation" and a
  nested one reads `users.1.email`. A request's `attributes` name fields themselves, with a translation key or a text per field,
  and `*` for one segment of a path: `{ 'links.*.url': 'link' }`.
- **`messages`** replace the framework's message of a rule. `{ 'slug.unique': 'notes.validation.slug_taken' }` replaces it for one
  field, `{ required: 'Fill this in.' }` for every field, and `<field>.<rule>` wins over `<rule>`. The rule is the part of the key
  after `marmeon.validation.`, so `max` for `max.string`. A message may use the rule's placeholders: `'Keep {attribute} under
  {max}.'`.
- **Own messages:** `regex()`, `custom()` and `unique(…, { message })` take a message of their own. It is a translation key, a
  text, or a message function, which `translatable(key, params, fallback)` of `@marmeon/http` and `trans()` of the localization
  package make: `.custom(isLongEnough, translatable('notes.validation.slug_min', { min: 3 }, 'At least {min}.'))`.

A request's `messages` and `attributes` reach the errors of a live validation too. The starter kit's registration shows the
pattern, the framework's rules in the app's words:

```ts
messages: { 'name.min': 'auth.validation.name_min', 'password_confirmation.confirmed': 'auth.validation.passwords_differ' },
```

## Live validation

A form can check a field while the user types, against the same schema that checks the submit. `useForm(…, { validate: true })`
and `<Form validate>` do it, and the [forms](forms.md#validating-while-typing) page shows the browser's side. The request is the
form's own: the same method, URL and body, plus a header that names the fields, `x-marmeon-validate: title,slug`.

The route runs as far as its validation: the middleware, including CSRF, authentication and rate limits, the bindings,
`authorize` and the schema. The controller is never built. The answer is a 204, or a 422 with the errors of the named fields only,
both with `x-marmeon-validated` naming the checked fields and `no-store`. Errors of fields not named are dropped, since they are not
filled in yet, and so are errors of the body as a whole.

- Field names are paths, such as `title`, `address.city` or `links.0.url`, at most 64 per request.
- A route without a body schema, such as a `GET` or a closure, has nothing to check and answers 400.
- A live validation is read-only: it writes no session, sets no cookie and does no work after its response.
- Live validations have a rate limit of their own, from the cache package that every new app has: 30 a minute per route and
  address. A `throttle()` on the route holds them to its limit without counting them. The
  [rate limiting](rate-limiting.md#live-validations) page shows how to change it.
- Files are never sent, and neither is any field that looks like a secret: a password or passphrase, a card number or security code, a one-time code, a token, a secret or a key (the [forms](forms.md#remembering-input) page lists the names). A strength rule or a confirmation of such a field is checked when the form is sent.

## Database rules, and why they never run live

```ts
slug: r.string().trim().required().unique(NoteRepository, 'slug', { ignore: (ctx) => ctx.params.note.id, where: (query, ctx) => query.where('user_id', '=', ctx.user.id) }),
folder_id: r.integer().exists(FolderRepository, 'id', { where: (query, ctx) => query.where('user_id', '=', ctx.user.id) }),
tags: r.array(r.integer().exists(TagRepository, 'id', { where: (query, ctx) => query.where('user_id', '=', ctx.user.id) })).max(10),
```

`query` in `where` is the repository's own, so a wrong column or value type is a compile error, and so is a callback that returns
something other than the query. `ctx` is `any` unless you annotate it; annotate it with the context the request has and a typo in it
is an error too:

```ts
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import type { HttpContext } from '@marmeon/http';

folder_id: r.integer().exists(FolderRepository, 'id', {
  where: (query, ctx: HttpContext<Authenticated, { workspace: Row<'workspaces'> }>) => query.where('workspace_id', '=', ctx.params.workspace.id),
}),
```

- **`unique(Repository, column, { ignore?, ignoreColumn?, where?, message? })`** passes when no row of the repository's table holds
  the value yet. `ignore` leaves out the row being edited, by `ignoreColumn`, `id` by default. `where` narrows the rows that count,
  say to one user's. Soft-deleted rows count, since the unique index holds them too.
- **`exists(Repository, column, { where?, message? })`** passes when a row holds the value. Soft-deleted rows do not count. It checks
  that the row exists, not that it belongs to the user: scope it with `where`, as above, or one user can point a record at another's.
- `column` is typed from the repository's rows.
- **In a list, the size comes first.** `r.array(…).min()`, `.max()` and `.between()` (and `r.list()`'s) check the number of items before
  the first item is looked at, so a list that is too long is refused without one query. The items of a list whose rules are
  asynchronous, database rules and `async` `custom()` rules, are checked eight at a time per list, not all at once. Without a `max()`, a list
  is as long as the request body allows: give such a list one.
- **The repository comes from the request.** The router hands every schema the request's scope, so the rule needs no factory.
  Outside a request, in a configuration or a job's payload, a database rule says so instead of guessing.

### Never in a live validation

A live validation answers while a field is being typed. A `unique` rule there would tell anyone who types an address whether it
has an account: in the background, without a submit, and without a rate limit that ever notices, since the limit of live
validations is generous enough for typing. So database rules and `async` `custom()` rules do not run in a live validation. A free
and a taken value get the same answer there, and only the submit tells, where the request's own rules and limits apply.

`.live()` opts a rule in, for a value whose being taken is no secret, such as a slug among one user's own notes. Never use it for
anything that tells whether an account exists. It goes on the field. On an object or a list it is a compile error. On a union it compiles, because a union is typed as any rule,
but it throws a `TypeError` when the rule is built. An object or a list wrapped in `.optional()` or `.nullable()` compiles the same way and throws the same way. All of them would open every rule inside, the address next to the slug:

```ts
r.object({ slug: r.string().unique(NoteRepository, 'slug').live(), email: r.email().unique(UserRepository, 'email') }); // slug live, email not
```

The starter kit's registration has no database rule at all. With private registration, the default, it never tells whether an
address is taken. With `AUTH_PRIVATE_REGISTRATION=false`, the unique index tells on submit, behind the registration's rate limit.

### The unique index is the truth

Two requests can race past `unique`: both see a free value, both insert. Keep the unique index in the migration, and let
`failOnDuplicate()` of `@marmeon/database` turn its conflict into the same 422 at the field:

```ts
import { failOnDuplicate } from '@marmeon/database';

await failOnDuplicate('slug', () => this.#notes.update(note.id, { slug: ctx.body.slug }), ctx.body);
await failOnDuplicate({ slug: 'address' }, () => this.#notes.insert(row), ctx.body); // column → form field, when they differ
```

The error speaks with the rule's message, in the request's language, with the request's `messages` and `attributes`. A violation of
another index stays a 500: a bug, not the user's input. In a transaction, the 422 rolls it back. `unique` gives the friendly
message before the insert, and the index is what holds.

> [!WARNING]
> An account's address is no slug: "taken" tells who has an account. Use a `unique` on an address only with
> `AUTH_PRIVATE_REGISTRATION=false`. Otherwise do what the starter kit does: the same answer for a free and a taken address, and a
> mail to the owner. The [security](security.md#private-registration) page explains why.

## Rules of your own

### `custom()`

`custom(check, message?)` runs a check of your own. It gets the value so far and `{ request }`, which holds the request's
`resolve`, its `ctx` and whether it is live, and is `undefined` outside a request. It answers `false` for its message, a message of
its own, or nothing for a valid value:

```ts
code: r.string().required().custom(async (code, { request }) => (await request!.resolve(Invites).valid(code)) || 'invites.validation.unknown'),
```

An `async` check makes the rule async, and like the database rules it does not run in a live validation unless the rule says
`.live()`. A check that returns a promise without being an `async` function is an error, never skipped in silence: a promise taken
for a valid answer would let everything through. A rule without an async part stays synchronous. An object with a `validate`
method works as the check too.

### `r.value()`

`r.value<Output, Input>(check, { meta })` is a rule for a value no other rule describes. `check` gets the value, a missing one
too, so it decides what missing means, and answers a message or nothing. The value is taken as it is. The rule has every rule's
methods, such as `nullable()`, `custom()` and `transform()`, and an async check goes into a `custom()` after it:

```ts
const slug = r.value<string>((value) => (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? undefined : 'notes.validation.slug'));
```

`meta` marks the rule with values under symbols, and every rule made from it keeps the mark. `metaOf(rule, key)` reads it, and is
`undefined` for anything else. That is how a package finds its own fields in an app's schema.

## Uploads

A file field is `upload()` of `@marmeon/storage`, an `r.value()` rule with its limits as a mark. The upload's target, asked for
before the form is sent, and the submit both find the field by it:

```ts
schema: r.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
```

`ctx.body.avatar` is then a `TemporaryUpload`, and an optional file is `upload(…).nullable()`. The type is read from the file's
first bytes, never from its name: HTML sent as `.png` is refused. `upload({ maxBytes, text: true })` takes a text file of any format, a CSV for one: no known binary
format, no markup at the start, no NUL byte (see [storage](storage.md#uploads) for what that does not promise). Nothing chosen is "Choose a file.". A file needs a field of its own: an `upload()` in a list, a
union or an optional object stops the start. The [requests](requests.md#files) page shows a whole controller.

## Queries

`r.query({ … })` reads a URL. A query never answers 422: a field the schema rejects falls back to its default. So every field needs
one or is `optional()`, and its rule must take a string, as `r.integer()`, `r.boolean()`, `r.in([10, 25])` and `r.array()` with a
repeated key do. `pageQuery()` of `@marmeon/database` brings the fields of a paginated list:

```ts
query: r.query({
  q: r.string().trim().max(60).default(''),
  sort: r.in(['title', '-title', 'created', '-created']).default('created'),
  ...pageQuery({ perPage: [10, 25, 50] }),
}),
// QueryOf: { q: string; sort: 'title' | '-title' | 'created' | '-created'; page: number; per_page: 10 | 25 | 50 }
```

The [requests](requests.md#query-schemas) page explains how a query is parsed, and the [pagination](pagination.md) page builds a
list on it. A [data table's](tables.md#the-url-is-strict) query is stricter on purpose: it answers 400.

## A schema built per request

A form's fields sometimes come from rows: the questions of an event, the options of a workspace. `schema` then takes a function
instead of a schema, and the router calls it for each request with `resolve` and the request's context:

```ts
export const AnswersRequest = defineRequest({
  schema: async (resolve, ctx: HttpContext<{}, { event: Event }>) => {
    const questions = await resolve(QuestionRepository).of(ctx.params.event.id);
    return r.object({
      answers: r.object(Object.fromEntries(questions.map((q) => [q.key, q.required ? r.string().trim().required() : r.string().trim().optional()]))),
    });
  },
  authorize: (ctx) => ctx.params.event.open,
});
```

- **`ctx` is the context of a request that was let on**: the middleware ran, the route's bindings found their records, every
  check and `authorize` said yes, and so did the route's `afterAuthorize` hooks. The function may read a bound record, such as
  `ctx.params.event`. Declare the context it needs as the type of the parameter, as for `authorize`.
- **It runs only then.** A request that a check or `authorize` refuses, or whose binding finds nothing, gets its 403 or 404
  without the function running, so it cannot be used to tell what exists or to load rows for anybody. A live validation builds
  the schema after the same decisions.
- **It may be `async`.** The router awaits it before the first field is validated. A function that throws or rejects ends the
  request with that error: an `HttpError` answers with its status, any other error is a 500. The controller does not run and
  no field is checked.
- **Errors sit at the fields you built**, such as `answers.diet`. `attributes` and `messages` are static, so they name fields
  you know in advance.
  How errors reach fields whose keys the rows decide is in [errors at nested and dynamic fields](forms.md#errors-at-nested-and-dynamic-fields).
- **The types follow the built schema.** `ContextOf` and `FormOf` read the schema the function returns, not its promise. A
  schema with keys that only the rows know is typed as a record (`Record<string, string>`), and `useForm()` gets that record.
- **Uploads in it are checked per request.** The start cannot read a schema that is built later, so a form shape it would refuse (a list of files, a file in an optional object; see [storage](storage.md#uploads)) is found when the request builds it, and answers 500.
- **It runs for every request.** Build as little as the schema needs, and keep rows in a repository that can cache them.
- **Live validation** of a schema built by `rules` works as for a static one. A schema of [another library](#other-libraries) is
  still left out unless the request says `live: true`.

The web app's lab shows it: `/lab/surveys/:survey` is a form whose fields are the rows of a table.

## Other libraries

A schema of any Standard Schema library works wherever a rule does: `defineRequest()`, `parseQuery()` and a job's
`static schema`. Your app installs the library itself:

```ts
import { z } from 'zod';
export const CreateNoteRequest = defineRequest({ schema: z.object({ title: z.string().min(1).max(120) }) });

import { type } from 'arktype';
export const RenameNoteRequest = defineRequest({ schema: type({ title: '0 < string <= 120' }) });
```

What you give up, and what to watch:

- **Messages** are the library's own. `messages`, `attributes` and `{attribute}` are for `rules`. For your language, pass the
  library a message function, such as `trans()` of the localization package, where it takes one.
- **Live validation** leaves such a schema out. Another library knows nothing of "live": an async check that asks the database
  would answer while the field is typed. So the router answers 204 without running the schema. `defineRequest({ schema, live:
  true })` runs it live, all of it, on every check of a field: only for a schema none of whose checks tells more than a submit
  would. Checks that tell whether a record exists belong in `rules`, as `unique`, `exists` or an async `custom()`, or in `handle()`.
- **A query schema** must still accept an empty query and take strings. The compiler names the field that does not.
- `r.object()` takes rules only. Mix nothing in: wrap the whole object in one library.
- A rule of ours inside another library's schema runs without the request. A database rule there throws, on submit too, and an
  async `custom()` that runs in a live validation has its error dropped. Put the whole object into `rules` instead.

### Coming from Valibot

A Valibot schema works as it is, since it is a Standard Schema too. To move it into `rules`, these are the common pieces:

| Valibot | Rules |
| --- | --- |
| `v.object({ … })`, `v.array(item)` | `r.object({ … })`, `r.array(item)` |
| `v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(255))` | `r.string().trim().required().max(255)` |
| `v.pipe(v.string(), v.email())` | `r.email()` |
| `v.optional(v.string())` | `r.string().optional()` |
| `v.nullable(v.pipe(v.string(), v.url()))` | `r.url().nullable()` |
| `v.optional(v.number(), 1)` | `r.number().default(1)` |
| `v.picklist(['title', '-title'])` | `r.in(['title', '-title'])` |
| `v.pipe(v.string(), v.transform(Number), v.integer())` | `r.integer()`, which takes `'42'` and `42` |
| `v.pipe(v.string(), v.check(isSlug, 'notes.validation.slug'))` | `r.string().custom(isSlug, 'notes.validation.slug')` |
| `v.forward(v.partialCheck(…, (input) => input.password === input.password_confirmation), ['password_confirmation'])` | `r.object({ … }).confirmed('password')` |

A message that used Valibot's `{requirement}` takes the rule's own placeholder, such as `{min}` or `{max}`.

## Type errors you will meet

The compiler refuses what cannot work, and its messages say what to do. TypeScript names the type first and the message on the
next line:

```text
r.query({ page: r.integer().min(1) })
  Type 'NumberRule' is not assignable to type '"Query field 'page' needs .default(…) — a query is parsed field by field and never
  answers 422 …"'.

r.query({ address: r.object({ city: r.string() }).optional() })
  … '"Query field 'address' is read from the URL as text — give it a rule that takes a string: r.string(), r.integer(),
  r.boolean(), r.in([…]), r.array(…)"'.

r.string().optional().max(3)
  Property 'max' does not exist on type 'Rule<string | undefined, string | undefined>'.        — the modifiers come last

r.integer().default('1')
  Argument of type 'string' is not assignable to parameter of type 'number'.                    — a default is an output value

r.string().unique(UserRepository, 'mail')
  Argument of type '"mail"' is not assignable to parameter of type '"email" | "id" | "name"'.   — a column of the repository's rows
```

## Outside a request

An import, a job or a command checks values with the same rules and messages as a form. `validate(schema, value, options?)` runs a
schema on a value and answers with a [Result](errors.md#results): the output, or the messages by field.

```ts
import { rules as r, validate } from '@marmeon/validation';

const Guest = r.object({ name: r.string().trim().required(), email: r.string().email().required() });

for (const [line, row] of rows.entries()) {
  const guest = await validate(Guest, row, { translator, resolve });
  if (!guest.ok) {
    report(line + 1, guest.error.errors); // { email: ['The email field must be a valid email address.'] }
    continue;
  }
  await guests.insert(guest.value);
}
```

- **`translator`** shows the messages in its language, such as `Translators.for('de')` ([localization](localization.md#translators-any-language-anywhere)). Without it, the
  messages are English. `messages` and `attributes` work as in `defineRequest()`.
- **`resolve`** builds the repositories of `unique` and `exists`: `(Class) => container.make(Class)`. Without it, such a rule
  throws with a message that says so, since it cannot ask the database.
- **`ctx`** does not exist. A `where` or `ignore` of a database rule that reads it, even to test `ctx ? … : …`, fails with an
  error that says so, so a filter by the user never falls away silently. Keep such rules to a request.
- **Any Standard Schema** works, not only `rules`, but `messages` and `attributes` are for `rules`.
- The error is `{ kind: 'invalid', errors }`, and a value that is not an object reports under `_`.

## Testing

A test checks the answer of a submit, and of a live validation:

```ts title="modules/notes/validation.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('checks the title, on submit and while typing', async () => {
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Draft', body: '', slug: 'draft' });
  const signedIn = app.actingAs(ada);
  await signedIn.expectingJson().put(`/notes/${note.id}`, { json: { title: '', slug: 'draft' } }).assertInvalid<UpdateNoteController>({ title: /required/ });
  await signedIn.validating('slug').put(`/notes/${note.id}`, { json: { title: '', slug: 'draft' } }).assertLiveValid('slug');
});
```

`assertInvalid` matches each field's first message against a text or a pattern, and `assertLiveValid` checks the 204 of a live
validation for the named fields. The [HTTP tests](http-tests.md) page covers every assertion.
