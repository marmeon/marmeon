# Landing

The code of the landing page at `/` that the notes demo ([`examples/notes`](../notes)) and the starter kit do not have: the page and
controller that show one note, its table types, the route `notes.show`, the test of the testing section, and the mail `NoteSharedMail` with its texts and test. The rest of what the
landing shows (the migration, the repository, the form) is read from the files of the notes demo as they are.

This is not an app you run from here. It is laid over the notes demo and the recipes in the same format as them (`files/`,
`edits.json`, `commands.json`). Every snippet of `apps/website/modules/site/snippets.ts` names the file of the app it is a piece of,
word for word. `pnpm pack:smoke` applies the overlay, finds each snippet in the app and runs the app's tests, type check and lint, so a
change to the framework that breaks a line of the landing page breaks that check. `pnpm test` compares the snippets with the files of
this directory and of `examples/notes/files` already.
