# Coding Agents

## Introduction

A coding agent that works in your app reads a file at the start of every session: `AGENTS.md`, or `CLAUDE.md` for Claude Code.
`marmeon agents:sync` writes both. It keeps a block in `AGENTS.md` that tells the agent how to work with Marmeon: where the
documentation is, which commands to run after a change and which rules the framework holds you to. The block comes with the
installed `marmeon`, so it changes when you update.

```sh
pnpm marmeon agents:sync
```

```txt
✓ Wrote AGENTS.md.
✓ Wrote CLAUDE.md.
```

Every app that `create-marmeon` makes, the starter kit and the blank app alike, has both files once the creator has installed it. With
`--no-install` the command is among the next steps it prints. Run the command yourself in an app that is older.

## What the command writes

`AGENTS.md` is the guide for every agent, whatever tool it runs in. The command makes it when it is missing: a title (the `name`
of your `package.json`), the block, and a section named "This app" for your own notes.

```md title="AGENTS.md"
# shop

<!-- marmeon:begin v1 -->
Managed by `marmeon agents:sync` — edits inside this block are replaced; write yours outside.
…
<!-- marmeon:end -->

## This app

Notes for agents that belong to this app go here.
```

`CLAUDE.md` holds one line, `@AGENTS.md`, which makes Claude Code read the same guide. The command writes it when it is missing
and never changes it afterwards: if your `CLAUDE.md` does not import `AGENTS.md`, the command says so and leaves the file alone.

## What belongs to the block and what to you

Everything between the two marks belongs to Marmeon, and the next `agents:sync` replaces it. Everything outside belongs to you,
and the command does not touch a byte of it: your own rules, your conventions, a section on how your team works. The command
looks only at lines that consist of a mark and nothing else.

- **A file without marks** gets the block appended after your text.
- **A file with one pair of marks** gets the text between them replaced.
- **Anything else is refused**: a begin without an end, two blocks, an end before the begin, a mark of a newer version than your
  `marmeon` knows. The command exits with 1, writes nothing and says what it found. It never guesses where your text ends.

A file that uses `\r\n` line ends keeps them, the block included.

`AGENTS.md` and `CLAUDE.md` may be symbolic links. The command follows a link that stays inside the app. It refuses a link that leads nowhere and a link that leads out of the app, exits with 1 and writes nothing.

## Keeping the block current

Run `marmeon agents:sync` after you update `marmeon`, and commit the result. In CI, `--check` writes nothing and tells you
whether the file is current:

```sh
pnpm marmeon agents:sync --check
```

It exits with 1 when `AGENTS.md` has no block or the block differs from the one your `marmeon` carries. An app that does not boot
still gets its guide: the command does not start the app.

## The marks

The marks name a version, `v1` today. The version is the shape of the marks, not the age of the text between them: the text may
change in every release and the marks stay `<!-- marmeon:begin v1 -->`. A `marmeon` that finds a mark of a newer version than it
writes leaves the file as it is and asks you to update. See [stored and wire formats](releases.md#stored-and-wire-formats).

## Naming your own commands

`agents:sync` is a command name of Marmeon, like `check` or `migrate`. An app that registers a command of its own with this name
no longer starts: every command that boots the app, `marmeon list` included, ends with the error `[marmeon:K8]` ("Two commands are
named …"). Rename your command. `agents:sync` itself does not boot the app and still runs. See
[writing commands](console.md#writing-commands).
