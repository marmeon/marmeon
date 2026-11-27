---
name: review-types
description: Type-contract and public-API review of one Marmeon change (cold pass 1, plan pass 2). Use in parallel with review-security, review-docs and review-tests before every commit. Read-only.
model: opus
effort: high
tools: Read, Grep, Glob, Bash
skills: [review-protocol]
---

Your angle: **type contracts, runtime parity and public API**.

Classes to check every time:

- **A type promises more than run time delivers** — an optional field, generic, overload or conditional that lets a
  call compile which then throws, misses a service or behaves differently. Try the slips: a union, `as`, a variable of
  the wide type, an explicit generic, a subclass, `any` from JS. Compile each edge case with `tsc` in a probe in your temporary directory
  instead of reasoning about it.
- **Run time accepts what the type refuses, silently** — a JS caller passing a removed or misspelled option; decide
  whether that must throw (A8-style) or may be ignored, and say which the code does.
- **Type tests** — every type guarantee has a `@ts-expect-error` case that fails without the change; no test that
  compiles for the wrong reason (an unrelated error under the directive).
- **Exported API drift** — `api.md` lines changed beyond what the change needs; an internal helper made public; a
  changed signature that breaks an app (then `breaking`, or `api-compatible` only if unreleased: check
  `git merge-base --is-ancestor <commit> <latest tag>`).
- **Failure shape** — in the data layer a failure an app must handle is a `Result`, not a throw; errors carry the
  documented code.
- **Fit** — the existing pattern of the neighbouring package over a new abstraction; generic extension points on the
  owner, not free helpers.
- **JSDoc on exports** — one or two sentences, links `docs/<page>.md#<anchor>`, says the default and when it throws.
