# Validation: rules, messages and what never runs live
<!-- docs:pending -->

Every input of a Marmeon app passes a schema: a form's body, a URL's query, a config's environment variables, a job's payload. The
schemas are **Standard Schema** objects — the one contract (E197) — and the framework's own way to write them is `rules` of
[@marmeon/validation](../packages/validation/README.md): Laravel's names (`required`, `max`, `email`, `in`, `confirmed`, `unique` …),
typed end to end, with messages in the request's language. This guide puts the parts together: a request from schema to handler,
the types a rule has, messages and their keys, queries and the environment, your own rules and uploads, the database rules — and why
they never answer while a field is being typed —, the type errors you will meet, other libraries, and the way over from Valibot.

```ts
import { rules as r } from '@marmeon/validation';
```

`rules` is server code. The browser never imports a rule — it imports the request's **types** (`FormOf`), and a test of the web
app's client build keeps every module of `@marmeon/validation` out of its chunks. Valibot is the engine under the rules: a dependency
of the package, never re-exported — an app installs `@marmeon/validation` and nothing else, and no type of it names Valibot (no
TS2742 in an app's `.d.ts`).

## A request, from schema to handler

```ts
// modules/user-profile/controllers/UpdateProfileController.ts
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const UpdateProfileRequest = defineRequest({
  schema: r.object({
    name:    r.string().trim().required().max(255),
    email:   r.string().trim().lowercase().required().email().max(255)
               .unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),   // the repository from the request — never live
    website: r.url().nullable(),
    tags:    r.array(r.string().max(30)).max(10).default([]),
  }),
  messages:   { 'email.unique': 'profile.validation.email_taken' },   // Laravel's messages(): a translation key or a text
  attributes: { email: 'profile.fields.email' },                     // Laravel's attributes(): the field's name in messages
});

export class UpdateProfileController extends Controller {
  static request = UpdateProfileRequest;

  async handle(ctx: ContextOf<typeof UpdateProfileRequest>) {
    // ctx.body: { name: string; email: string; website: string | null; tags: string[] } — trimmed, lower-cased, filled in
  }
}
```

The router runs a request in a fixed order — middleware, route bindings, `authorize`, the query, then the body's schema — and builds
the controller only when everything passed ([controllers and requests](../packages/router/README.md#controllers-and-requests)). A
body that fails is a **422** with the errors per field: a form shows them under its fields, a JSON client gets
`{ message, errors: { email: ['…'] } }`. The schema sees the body only, never the query (E65).

The same rules serve every other place that takes a schema: `query` of a request (a [query](#queries-every-field-has-a-default)),
`env` of a `defineConfig` ([environment variables](#environment-variables)), `static schema` of a job (its payload — `r.object({
userId: r.integer() })`), and `parseQuery` by hand.

## The rules — and the order they run in

| Start with | Takes | Gives |
| --- | --- | --- |
| `r.string()` | a string, never one with a NUL character | `string` |
| `r.number()`, `r.integer()` | a number, or a string that spells one (`'42'`, `'-1.5'`) | `number` |
| `r.boolean()` | `true`/`false`, `1`/`0`, `'on'`/`'off'`, `'yes'`/`'no'`, `'true'`/`'false'` | `boolean` |
| `r.accepted()` | a ticked checkbox — missing is "must be accepted" | `true` |
| `r.in([…])`, `r.literal(v)`, `r.union([…])` | one of the values (a number also as a form spells it), exactly `v`, what the first rule takes | the value |
| `r.object({…})`, `r.array(rule)` | an object (unknown fields are left out), a list | the fields' outputs, a list |
| `r.email()`, `r.url()`, `r.uuid()`, `r.date()`, `r.isoTimestamp()` | `r.string()` with that check | `string` |
| `r.query({…})`, `r.env({…})`, `r.port()`, `r.list(rule)` | a URL's fields, environment variables, a port, a comma-separated list | |
| `r.value<Output, Input>(check)` | what `check` passes — a type of your own | the value |

Then the type's checks, **in the order you write them** — `trim()` before `required()`, so `' '` is missing:

- strings: `trim()`, `lowercase()`, `required()`, `min(n)`, `max(n)`, `between(a, b)` (code points, as Postgres counts),
  `email()`, `url({ protocols })`, `uuid()`, `regex(pattern, message?)`, `date()`, `isoTimestamp()`;
- numbers: `integer()`, `min(n)`, `max(n)`, `between(a, b)`; lists: `required()`, `min`, `max`, `between` (items);
- objects: `when(condition, fields)`, `confirmed(field)`, `entries`;
- every rule: `transform(fn)`, `custom(check, message?)`, `unique(…)`, `exists(…)`, `live()` — and last the modifiers
  `optional()`, `nullable()`, `default(value)`.

A rule is **immutable** (each method returns a new one): `const email = r.email().max(255)` can be shared and extended. **The first
problem of a field only** — Laravel's `bail`, as the default: a form shows one message per field, so `r.string().trim().required()
.email()` says "required" for `' '` and never also "must be a valid email". `r.url()` takes absolute **http and https** URLs only
(a `javascript:` URL in an `href` runs in every visitor's browser; `r.url({ protocols: ['https', 'mailto'] })` names others), and a
`regex()` loses its `g` and `y` flags. The whole catalogue, each rule with what it takes: [the rules](../packages/validation/README.md#the-rules).

What an empty string is depends on the rule's type (E208) — [the next section](#empty-strings-a-value-or-missing--by-type).

## Empty strings: a value or missing — by type

A form sends every field as a string, an empty one as `''`; a JSON client sends `''` on purpose. Laravel turns every `''` into `null`
(`ConvertEmptyStringsToNull`) — which breaks the JSON case: a page builder's optional "Subtitle" that someone clears on purpose is
`''`, and it must arrive as `''` — neither as missing (the block would keep its old subtitle) nor as an error. So the rules decide
**by type** (E208): where `''` can be a value of the rule, it is one; where it never can, it is a form's empty field and counts as
missing.

| Rule | `''` with `optional()` / `nullable()` / `default(v)` | `''` without a modifier |
| --- | --- | --- |
| `r.string()` with `trim()`, `lowercase()`, `max()`, `custom()`, `transform()` | `''` — a value, kept | `''` |
| `r.string()` with `required()`, `min(n)`, a `regex()` that wants a character | `''` reaches the check: "required", "at least n characters", "format is invalid" | the same |
| `r.in([…])`, `r.literal(v)` with `''` among the values | `''` | `''` |
| `r.in([…])`, `r.literal(v)` without `''` (a `<select>`'s placeholder) | missing: `undefined` / `null` / `v` | "required" |
| `r.union([…])` | `''` when one of its rules keeps it, else missing | what its rules say |
| `r.number()`, `r.integer()`, `r.port()`, `r.boolean()`, `r.accepted()` | missing | "required" (`accepted`: "must be accepted") |
| `r.email()`, `r.url()`, `r.uuid()`, `r.date()`, `r.isoTimestamp()` (also as `r.string().email()` …) | missing | the format's message |
| `r.array()`, `r.list()`, `r.object()`, `r.value()` (an upload too) | missing | `r.array()`, `r.object()`: "required"; `r.list()`: an empty list; `r.value()`: its check |

```ts
schema: r.object({
  title:    r.string().trim().required().max(80),
  subtitle: r.string().trim().max(120).optional(),   // '' → '' (cleared on purpose); left out → undefined (unchanged)
  width:    r.integer().min(1).optional(),            // '' → undefined: an empty number field
  link:     r.url().nullable(),                       // '' → null
  align:    r.in(['left', 'center']).default('left'), // '' → 'left': the select's placeholder
}),
```

`trim()` runs inside the rule, after the modifier looked: `'   '` with `r.string().trim().optional()` becomes `''` — kept, like a
`''` sent as it is; with `.required()` it is "required". A form and a JSON client get the same answer: the router hands both the
strings they sent. The web app's profile shows it: a bio cleared on purpose saves `''`, a request without a bio keeps it
(`UpdateUserProfileController`).

**Queries follow the type too** — an empty field of a GET form (`?q=`) is `''` for `r.string()`, missing for `r.integer()` or an
`r.in()` without `''` (its default). **Environment variables are the exception:** in `r.env()` every empty variable counts as
missing, for `r.string()` too — `S3_BUCKET=` in a `.env.example` means "not set", and a `.env` has no other way to say it.

The way back — a string field where `''` should be missing, as before (or as in Laravel): turn it into `undefined` (or `null`) after
the checks.

```ts
subtitle: r.string().trim().max(120).transform((text) => (text === '' ? undefined : text)).optional(),  // '' → undefined
caption:  r.string().max(200).transform((text) => (text === '' ? null : text)).nullable(),              // '' → null
// With a check '' fails (min(2)): let '' through first — r.literal('') or the rule.
nickname: r.union([r.literal(''), r.string().trim().min(2).max(30)]).transform((name) => (name === '' ? undefined : name)).optional(),
```

## Types: what comes in, what goes out

A rule has two types — what it takes (its **input**) and what it gives (its **output**) — and the router's helpers read them:

| Helper | Reads | Example |
| --- | --- | --- |
| `ctx.body` (`ContextOf<typeof Request>`) | the body's output | `{ name: string; email: string; website: string \| null; tags: string[] }` |
| `FormOf<typeof Controller>` | the body's **input** — what a form sends; `useForm` types its fields with it | `{ name: string; email: string; website: string \| null; tags?: string[] }` |
| `QueryOf<typeof Controller>` | the parsed query (output) | `{ sort: 'name' \| '-name'; page: number }` |
| `ConfigOf<typeof Config>` | what `resolve` makes of the env's output | `{ port: number; admins: string[] }` |

The modifiers and `transform()` change them, and that is the point of having two:

```ts
r.integer()                                             // input number | `${number}`             output number
r.integer().nullable()                                  // input number | `${number}` | null      output number | null
r.boolean().default(false)                              // input BooleanInput | undefined         output boolean
r.string().optional()                                   // input string | undefined               output string | undefined
r.string().trim().transform((text) => text.split(' '))  // input string                           output string[]
```

`default()` makes a field optional in the input and always there in the output (a list or object default is copied for every
validation — nobody shares it). The modifiers come **last**: after them the type's checks are gone from the API. A `when()` field is
optional in the output.

## Messages: English, German and your own words

Every rule's message has a key and parameters — `marmeon.validation.<rule>[.<type>]` (`required`, `max.string`, `max.number`,
`email`, `unique` …) with `attribute`, `min`, `max` — and the request's translator turns it into the request's language.
[@marmeon/i18n](../packages/i18n/README.md) ships English and German for **every** rule (a test holds both to the same keys and
placeholders); an app without @marmeon/i18n gets the English text:

```text
en  The email field must not be longer than 255 characters.        marmeon.validation.max.string  { attribute: 'email', max: 255 }
de  Das Feld E-Mail darf höchstens 255 Zeichen haben.              (with attributes: { email: 'profile.fields.email' } → "E-Mail")
en  The password confirmation does not match.                      marmeon.validation.confirmed — reported on password_confirmation
de  Der Wert für E-Mail ist bereits vergeben.                      marmeon.validation.unique
```

- **`{attribute}`** is the field's path with underscores as spaces (`password_confirmation` → "password confirmation",
  `users.1.email`) — or the request's **`attributes`**: a translation key or a text per field, `*` for one segment
  (`{ 'links.*.url': 'link' }`). In an `r.env()` it is the variable as written (`APP_PORT`).
- **`messages`** replace the framework's message of a rule: `{ 'email.unique': 'profile.validation.email_taken' }` for one field,
  `{ required: 'Fill this in.' }` for every field — `<field>.<rule>` wins over `<rule>`; the rule is the part after
  `marmeon.validation.` (`max` for `max.string`). A message may use the rule's placeholders — `'Keep {attribute} under {max}.'` —
  where Valibot's `trans()` had `{requirement}`.
- `regex()`, `custom()` and `unique({ message })` take a message of their own: a key, a text, or a message function
  (`translatable(key, params, english)` of the router, `trans()` of @marmeon/i18n).
- A request's `messages` and `attributes` reach a live validation's errors too.

The starter kit's registration shows the pattern: the framework's rules, the app's words —
`messages: { 'name.min': 'auth.validation.name_min', 'password_confirmation.confirmed': 'auth.validation.passwords_differ' }` —
"Der Name braucht mindestens 2 Zeichen.", "Die Passwörter stimmen nicht überein."

## Queries: every field has a default

`r.query({ … })` reads a URL (E55/E56). Links outlive their pages and people type URLs, so **a query never answers 422**: a field
the schema rejects falls back to its default (`/people?sort=DROP TABLE` is the list by name). So every field needs one — or is
`optional()` —, and its rule must take a string (`r.integer()`, `r.boolean()` and `r.in([10, 25])` take their spelling; `r.array()`
takes a repeated key, `?tag=a&tag=b`):

```ts
export const ListPeopleRequest = defineRequest({
  query: r.query({
    q: r.string().trim().max(60).default(''),
    sort: r.in(['name', '-name', 'joined', '-joined']).default('name'),
    ...pageQuery({ perPage: [10, 25, 50] }),        // @marmeon/database: page and per_page, rules too
  }),
});
// QueryOf: { q: string; sort: 'name' | '-name' | 'joined' | '-joined'; page: number; per_page: 10 | 25 | 50 }
```

A field without a default does not compile — the message says why ([type errors](#type-errors-you-will-meet)). Spread one query's
fields into another with `entries` (`r.query({ ...MembersTable.query.entries, tab: … })`). The guide [lists](pagination.md) builds a whole
list on it; a [table's](tables.md) query is stricter on purpose (400).

## Environment variables

`r.env({ … })` is the `env` of a `defineConfig`: every variable is a string, read like a query — `r.integer()`, `r.boolean()`,
`r.port()` (1–65535) and `r.list(rule)` (`ADMINS=ada@example.com, alan@example.com`, each item checked) — and an empty variable is
missing, whatever its rule (`S3_BUCKET=` is "not set", for `r.string()` too — [unlike a form](#empty-strings-a-value-or-missing--by-type)):

```ts
export const AppConfig = defineConfig('app', {
  env: r.env({ APP_PORT: r.port().default(3960), INVITES: r.boolean().default(false), ADMINS: r.list(r.email()).default([]) }),
  resolve: (env) => ({ port: env.APP_PORT, invites: env.INVITES, admins: env.ADMINS }),
});
// ConfigOf<typeof AppConfig>: { port: number; invites: boolean; admins: string[] }
```

A wrong value stops the start, naming every variable at once:

```text
Invalid configuration — the application cannot start:
  • app: APP_PORT — The APP_PORT field must be a port number from 1 to 65535.
  • app: ADMINS.1 — The ADMINS.1 field must be a valid email address.
Set these variables in the environment or in .env (see .env.example).
```

## Objects, confirmations and conditional fields

```ts
schema: r.object({ password: password(), password_confirmation: r.string() }).confirmed('password'),     // password() of @marmeon/auth

r.object({ kind: r.in(['person', 'company']), name: r.string().required() })
  .when((data) => data.kind === 'company', { vat: r.string().trim().required() })                      // checked only for a company
```

`confirmed(field, confirmation = '<field>_confirmation')` compares the two fields as typed and reports on the confirmation — once the
field itself is valid (a form that sends both wrong shows the password's problem first). `when()` is Laravel's
`sometimes`/`required_if`: the fields are checked while the condition holds for the object's other fields and left out otherwise.
Issues of nested fields carry their full path (`address.city`, `links.0.url`) — what a form's errors and a live validation use.

## Rules of your own: `custom()` and `r.value()`

`custom(check, message?)` is Laravel's `ValidationRule`: the check gets the value so far and `{ request }` (the request's `resolve`,
its `ctx`, whether it is live — `undefined` outside a request) and answers `false` (the message), a message of its own, or nothing:

```ts
code: r.string().required().custom(async (code, { request }) => (await request!.resolve(Invites).valid(code)) || 'invites.validation.unknown'),
```

An `async` check makes the rule async — and, like the database rules, it does **not** run in a live validation unless the rule says
`.live()`. A check that returns a Promise without being an `async` function is an error, never skipped in silence (a Promise taken
for a valid answer would let everything through).

`r.value<Output, Input>(check, { meta })` is a rule for a type no other rule describes: `check` gets the value — a missing one too —
and answers a message or nothing; the value is taken as it is. `meta` marks the rule, and every rule made from it (`.nullable()`,
`.custom()`, `.transform()`) keeps the mark; `metaOf(rule, key)` reads it — how a package finds its own fields in an app's schema:

```ts
const slug = r.value<string>((value) => (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? undefined : 'teams.validation.slug'));
```

## Uploads

A file field is `upload()` of [@marmeon/storage](../packages/storage/README.md#uploads) — an `r.value()` rule with its limits as a
mark, which is how the upload target (before the form is sent) and the submit (before the schema runs) find the field:

```ts
export const UpdateAvatarRequest = defineRequest({
  schema: r.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
  authorize: can(ProfilePolicy, 'update', 'user'),
});
// ctx.body.avatar: TemporaryUpload — `await ctx.body.avatar.store(disk, 'avatars')`; an optional file is upload(…).nullable()
```

The type is read from the file's first bytes, never from its name ("Dieser Dateityp ist nicht erlaubt (erlaubt: PNG, JPG, WEBP)." for
HTML sent as `.png`); nothing chosen is "Choose a file.". Lists of files are not supported yet.

## Database rules, and why they never run live

```ts
email: r.string().trim().lowercase().required().email()
         .unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id, where: (query, ctx) => query.where('team_id', '=', ctx.user.team_id) }),
team_id: r.integer().exists(TeamRepository, 'id'),
```

- **`unique(Repository, column, { ignore?, ignoreColumn?, where?, message? })`** — the value is in no row yet (soft-deleted rows
  count: the unique index holds them too); `ignore` leaves out the row being edited. **`exists(Repository, column, { where?,
  message? })`** — the value is in a row (soft-deleted rows do not count). `column` is typed from the repository's rows.
- **The repository comes from the request**: the router hands every schema its `resolve` (Standard Schema's
  `libraryOptions.marmeon`), so no `schema: (resolve) => …` factory is needed. Outside a request — a config, a job's payload — a
  database rule says so instead of guessing.

**They never run in a live validation** (E187, E193, E197). A live validation (E62) checks a field while it is being typed: the form
sends its own request with `x-marmeon-validate: email`, and the route answers 204 or the field's errors. A `unique` there would tell
anyone who types an address whether it has an account — in the background, without a submit, without a throttle that ever notices
(live validations have a limit of their own, generous for typing). So database rules and async `custom()` rules do not run live: a
free and a taken address get the **same** answer, and only the submit tells — where the throttle and the request's own rules apply.
A schema of **another library** does not run in a live validation at all (E206, fail-closed — the router cannot see which of its
checks ask the database): the answer is 204 unless its request says `live: true`. And should one of ours run inside such a schema that
calls it without the request, a database rule throws (it needs the request — a 500, on submit too) and an async `custom()` is dropped by
the mark on its issue (`NOT_LIVE`). Measures each tested on its own.

`.live()` opts a rule in, for values whose being taken is no secret — a team's slug inside the team's own settings. **Never** for
anything that tells whether an account exists. It goes on the **field**: on an object, a list or a union it is a compile error and
throws — it would open every rule inside, the address next to the slug:

```ts
r.object({ slug: r.string().unique(TeamRepository, 'slug').live(), email: r.email().unique(UserRepository, 'email') })   // slug live, email not
r.object({ … }).live()   // ✗ The 'this' context of type 'ObjectRule<…>' is not assignable to method's 'this' of type '".live() goes on the field …"'
``` The registration of `make:auth` has no database rule at all: with private
registration (the default, E146/E193) it never tells, and with `AUTH_PRIVATE_REGISTRATION=false` the unique index tells on submit
([private registration](../packages/auth/README.md#private-registration-e146-e193)). An app that wants the old live "taken" back
writes it itself — knowing what it gives away:

```ts
email: email.custom(async (address, { request }) => !(await request!.resolve(UserRepository).findByEmail(address)) || 'auth.validation.email_taken').live(),
```

**The unique index is the truth.** Two requests can race past `unique` — both see a free address, both insert. Keep the index in the
migration (`table.string('email').unique()`) and let `failOnDuplicate()` of [@marmeon/database](../packages/database/README.md#queries-module-boundaries-and-relations)
turn its conflict into the same 422 at the field (the rule's message, in the request's language, with the request's `messages` and
`attributes` — the router lends them to a `ValidationError` of the handler); a violation of another index stays a 500 — a bug, not the
input:

```ts
import { failOnDuplicate } from '@marmeon/database';

await failOnDuplicate('slug', () => this.#teams.update(team.id, { slug: ctx.body.slug }), ctx.body);
await failOnDuplicate({ slug: 'address' }, () => this.#teams.insert(row), ctx.body);   // column → form field, when they differ
```

In a transaction the 422 rolls it back. `unique` gives the friendly message before the insert; the index is what holds. An
**account's address** is no team slug: "taken" there tells who has an account — use it only with `AUTH_PRIVATE_REGISTRATION=false`;
otherwise do what `make:auth` does (the same answer for a free and a taken address, a mail to the owner — [security](security.md)).
The web app's `/lab/validation` shows both: the rule on one route, and on a second without it the index answering through
`failOnDuplicate()` with the same message.

## Type errors you will meet

The compiler refuses what cannot work, and the messages say what to do (quoted as `tsc` prints them; TypeScript names the
intersection first, then — on the next line — the message):

```text
r.query({ page: r.integer().min(1) })
  Type 'NumberRule' is not assignable to type '"Query field 'page' needs .default(…) — a query is parsed field by field and never
  answers 422 (E56); .optional() leaves it undefined"'.

r.query({ address: r.object({ city: r.string() }).optional() })
  … '"Query field 'address' is read from the URL as text — give it a rule that takes a string: r.string(), r.integer(),
  r.boolean(), r.in([…]), r.array(…)"'.

r.env({ TAGS: r.array(r.string()) })
  … '"Environment variable 'TAGS' is text — give it a rule that takes a string: r.string(), r.integer(), r.boolean(), r.port(),
  r.list(…)"'.

r.string().optional().max(3)
  Property 'max' does not exist on type 'Rule<string | undefined, string | undefined>'.        — the modifiers come last

r.integer().default('1')
  Argument of type 'string' is not assignable to parameter of type 'number'.                    — a default is an output value

r.string().unique(UserRepository, 'mail')
  Argument of type '"mail"' is not assignable to parameter of type '"email" | "id" | "name"'.   — a column of the repository's rows
```

## Other libraries: Zod, ArkType, Valibot

Standard Schema stays the contract (E197): a schema of **any** Standard Schema library works wherever a rule does — `defineRequest`,
`parseQuery`, `defineConfig`, a job's `static schema`. The app installs that library itself (`pnpm add zod`); Marmeon brings none:

```ts
import { z } from 'zod';
export const CreateNoteRequest = defineRequest({ schema: z.object({ title: z.string().min(1).max(120) }) });

import { type } from 'arktype';
export const RenameNoteRequest = defineRequest({ schema: type({ title: '0 < string <= 120' }) });
```

What you give up, and what to watch:

- **Messages** are the library's own, as it writes them — `messages`, `attributes` and `{attribute}` are for `rules`. For your own
  language, pass the library a message function (`trans()` of @marmeon/i18n, where it takes one).
- **Live validation** leaves it out (E206): another library knows nothing of "live" — an async `refine()` that asks the database would
  answer while the field is typed — so the router answers 204 without running the schema. `defineRequest({ schema, live: true })`
  runs it live, all of it, on every check of a field: only for a schema none of whose checks tells more than a submit. Checks that
  tell whether a record exists belong in `rules` (`unique`, `exists`, an async `custom()`) or in `handle()`.
- A **query** schema must still be total — every field optional or with a default, string input; the type check (`CheckQuery`) says
  which field is not.
- `r.object()` takes rules only: mix nothing in — wrap the whole object in one library.

## Moving over from Valibot

Before Wave 10 the starter, `make:auth` and the docs wrote Valibot; the framework's helpers (`password()`, `pageQuery()`, `upload()`, a
table's query) were Valibot schemas. Now they are rules, and the app needs no `valibot` (`pnpm add @marmeon/validation && pnpm remove
valibot` — unless your own code keeps using it, which works):

```ts
// before — import * as v from 'valibot'                   // after — import { rules as r } from '@marmeon/validation'
v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(255))  r.string().trim().required().max(255)
v.pipe(v.string(), v.email())                                 r.email()
v.optional(v.string())                                        r.string().optional()
v.nullish(v.pipe(v.string(), v.url()))                        r.url().nullable()
v.optional(v.number(), 1)                                     r.number().default(1)
v.picklist(['name', '-name'])                                 r.in(['name', '-name'])
v.pipe(v.string(), v.transform(Number), v.integer())          r.integer()                     (takes '42' and 42)
v.pipe(v.string(), v.check(isSlug, 'teams.validation.slug'))  r.string().custom(isSlug, 'teams.validation.slug')
confirmed(v.object({ password: password(),                    r.object({ password: password(), password_confirmation: r.string() })
  password_confirmation: v.string() }))                         .confirmed('password')
v.object({ ...pageQuery({ perPage: [25, 50] }), … })          r.query({ ...pageQuery({ perPage: [25, 50] }), … })
v.object({ avatar: v.nullish(upload({ maxBytes })) })         r.object({ avatar: upload({ maxBytes }).nullable() })
env: v.object({ APP_URL: v.pipe(v.string(), v.url()) })       env: r.env({ APP_URL: r.url() })
schema: (resolve) => v.objectAsync({ … checkAsync … })        r.object({ … }) with .unique()/.exists()/async .custom() — no factory
```

- Messages: a key in the app's language files that used Valibot's `{requirement}` gets the rule's own placeholder — `{min}`, `{max}`.
  Keys you passed to every `v.nonEmpty(trans(…))` move into the request's `messages` (`'name.required': …`) — or go: the framework
  has English and German texts for each rule.
- `confirmed()` of @marmeon/auth is gone; the object's `.confirmed('password')` reports on `password_confirmation` (key
  `marmeon.validation.confirmed`) and compares as typed.
- Keep a Valibot schema where you like: it is a Standard Schema too. Only the framework's helpers moved — `password()` no longer fits
  into a `v.object()` (wrap the object in `r.object()`, or check the password with Valibot).

The entry in [UPGRADING](../UPGRADING.md#medium-the-app-validates-with-rules--password-pagequery-upload-and-a-tables-query-are-rules-confirmed-of-marmeonauth-is-gone)
lists every change; [the package's README](../packages/validation/README.md) every rule.
