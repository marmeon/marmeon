# Coding Agents

## Introduction

A coding agent that works in your app reads a file at the start of every session: `AGENTS.md`, or `CLAUDE.md` for Claude Code.
`marmeon agents:sync` writes both. It keeps a block in `AGENTS.md` that tells the agent how to work with Marmeon: where the
documentation of the installed version lies (`node_modules/marmeon/docs/`, which `marmeon docs` reads), which recipe to start a task from (a resource, a public form, a background job), which commands to run after a change and which rules the framework holds you to. The block comes with the
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

`marmeon check` also looks at the block, as the [`agents` check](check.md#the-agents-block): a block that is missing or out of date is a
warning there, never an error, and the check writes nothing. An app without `AGENTS.md` is skipped.

## Skills and the MCP server

Marmeon ships skills for coding agents, short guides for a task: `marmeon-feature-module` (a new feature as a module),
`marmeon-migration` (a schema change), `marmeon-security-review` (what to check before a change goes out) and `marmeon-testing` (tests
for routes, jobs, mail and pages). The same command enters the
server `marmeon mcp` in `.mcp.json`, so an agent can ask the app for its routes and the installed documentation. Nothing is
installed until you ask:

```sh
pnpm marmeon agents:install
```

```txt
✓ Wrote .claude/skills/marmeon-feature-module/SKILL.md.
✓ Wrote .claude/skills/marmeon-migration/SKILL.md.
✓ Wrote .claude/skills/marmeon-security-review/SKILL.md.
✓ Wrote .claude/skills/marmeon-testing/SKILL.md.
✓ Wrote .mcp.json.
Your agent asks you to approve the server marmeon the next time it starts.
```

Commit the result. Claude Code reads `.claude/skills/`; Cursor and Copilot read that folder too. `--shared` writes the skills to
`.agents/skills/` instead, the folder of the open skills standard that Codex, Gemini CLI, Cursor and Copilot read. The skills never lie
in both folders, or Cursor and Copilot would list each twice. `--no-mcp` leaves `.mcp.json` alone.

### What the command owns

The command writes only folders named `marmeon-*`, and only a `SKILL.md` that carries the mark `marmeon-skill: "1"` under `metadata:`.
Other files in such a folder, and all your own skills, stay as they are. Copy a skill to a folder with another name to change it.

- A `SKILL.md` without the mark, or with one the command cannot read, is a file of yours: the command refuses and writes nothing.
- A mark with a higher number comes from a newer `marmeon`: the command refuses and asks you to update.
- A skill that an older `marmeon` installed and this one no longer ships is named in a warning and never deleted.
- In `.mcp.json` only the entry `marmeon` belongs to the command. It is replaced when it differs, and the command says so; every other
  entry, key and their order stay, as do the indentation and the line ends. The file is written again with `JSON.stringify`, so
  the formatting inside other entries changes and a key that occurs twice keeps its last value. A file that is not valid JSON, whose root
  is not an object or whose `mcpServers` is not an object is not repaired: the command refuses and writes nothing.
- The entry is treated like the skills. A first install adds it (not with `--no-mcp`); after that it is kept current only where it is
  there. Skills installed without it, or an entry you removed, stay that way: add the entry by hand as shown under [other
  clients](#other-clients).
- A link that stays inside the app is followed and stays a link: the file it leads to is replaced. A link that leads nowhere or out of the
  app, anything on the way that is not a directory, and a `SKILL.md` or `.mcp.json` that is not a regular file make the command refuse and
  write nothing, as does a folder it may not write to. Every file is written whole and renamed into place, so an interrupted run leaves the old
  file. A skill whose only difference is the line ends or a byte order mark that a checkout added counts as current.

The entry reads `node node_modules/marmeon/bin/marmeon.js mcp` from the app's root: no `npx`, which could download a package, and no
variable that only some clients expand.

### Keeping them current

Run `marmeon agents:install` again after you update `marmeon`, and commit the result. It updates where skills with the mark already
lie. `--check` writes nothing and exits with 1 when a skill or the entry is missing or out of date, or with "Not installed" when there
is nothing to check.

```sh
pnpm marmeon agents:install --check
```

`marmeon check` looks at the same files: where skills or the entry are installed, a skill that is missing or out of date, or an
existing entry that is out of date, is a warning with the fix `marmeon agents:install`, and nothing is written. An app that installed nothing gets no message. The block
of `AGENTS.md` names the command in one line, so an agent that reads the file learns of the skills; `marmeon agents:sync` brings
that line into an existing file. What the server offers an agent is on [the MCP server](mcp.md).

### Other clients

The command writes the files of Claude Code. For other clients, add the server by hand: the command is `node` and the argument list is
`node_modules/marmeon/bin/marmeon.js` and `mcp`.

- **Codex:** `codex mcp add marmeon -- node node_modules/marmeon/bin/marmeon.js mcp`, or a table `[mcp_servers.marmeon]` with `command = "node"`
  and `args = ["node_modules/marmeon/bin/marmeon.js", "mcp"]` in `.codex/config.toml`.
- **Cursor:** the same `mcpServers` object in `.cursor/mcp.json`.
- **VS Code (Copilot):** `.vscode/mcp.json`, with the object under `servers` instead of `mcpServers`.

## The marks

The marks name a version, `v1` today. The version is the shape of the marks, not the age of the text between them: the text may
change in every release and the marks stay `<!-- marmeon:begin v1 -->`. A `marmeon` that finds a mark of a newer version than it
writes leaves the file as it is and asks you to update. See [stored and wire formats](releases.md#stored-and-wire-formats).

## Naming your own commands

`agents:sync` is a command name of Marmeon, like `check` or `migrate`. An app that registers a command of its own with this name
no longer starts: every command that boots the app, `marmeon list` included, ends with the error `[marmeon:K8]` ("Two commands are
named …"). Rename your command. `agents:sync` itself does not boot the app and still runs. See
[writing commands](console.md#writing-commands).

`agents` is also the name of a check of `marmeon check`. A check of a package or a module with this name no longer registers: every command that
boots the app ends with the error `[marmeon:K11]`. Rename your check. See [package development](package-development.md#checks).
