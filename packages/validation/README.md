# @marmeon/validation

The validation rules of Marmeon apps — `r.string()`, `r.integer()`, `r.email()`, `r.object()`, `.unique()` and the rest —
typed from end to end, with messages in the request's language, for request bodies, queries and job payloads.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

Its engine, Valibot, is a dependency of this package and never re-exported: apps validate with `rules`. The rules are Standard
Schema objects, so a schema of another library works where the framework takes one.

## A request

```ts title="modules/notes/controllers/StoreNoteController.ts"
import { defineRequest } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const StoreNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(200) }),
});
```

A controller with `static request = StoreNoteRequest` gets `ctx.body` typed as `{ title: string }`, trimmed and checked. A form
that fails gets its errors back, in the visitor's language.

## Documentation

- [Validation](https://marmeon.com/docs/validation)
- [Validation: available rules](https://marmeon.com/docs/validation#available-rules)
- [Validation: live validation](https://marmeon.com/docs/validation#live-validation)
- [Validation: database rules](https://marmeon.com/docs/validation#database-rules-and-why-they-never-run-live)
- [Validation: other libraries](https://marmeon.com/docs/validation#other-libraries)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
