# Notes

A small notes app on the starter kit, built step by step in the docs page [Your First App](https://marmeon.com/docs/first-app):
people write notes, change them, pin the important ones, delete the ones they no longer need, and see only their own. It shows how
to build with the kit: a module with a migration, a repository, a policy, requests, controllers and two pages that use the kit's
classes (`.card`, `.button`, `.field`, `.stack`, …) and no styles of their own.

This is not an app you run from here. It is what turns a fresh starter kit into the notes app:

| What | Where |
| --- | --- |
| The new module, copied as it is into the app | `files/` |
| The few lines changed in files the kit already has | `edits.json` |
| The commands to run before and after copying, in order | `commands.json` |

`files/modules/notes/` is the module, `files/modules/notes/notes.test.ts` its tests. `marmeon make:module notes` and a
`make:controller` for each controller run first; the copy then replaces the files they wrote. `edits.json` adds the "Notes" link
to the navigation in `modules/auth/layouts/AppLayout.tsx`. Each `find` in it occurs exactly once in a fresh kit.

`pnpm pack:smoke` applies the overlay to an app made from the packed framework, runs the commands, and then the app's tests, type
check, lint, build and start. A change to the kit that breaks the notes app breaks that check.

## What it uses

- The table `notes`: a title, a body, a `pinned` flag, and the user it belongs to (deleted with the user).
- `NoteRepository` for the queries, with the pinned notes first on a page of ten.
- `NotePolicy`: somebody else's note answers 404, as one that does not exist does.
- Routes behind `authenticate()` and `verified()`, with the note in the URL bound by its repository.
- `<Form>`, `<Pagination>` and a link with `confirm` for deleting, worded in English and German.
