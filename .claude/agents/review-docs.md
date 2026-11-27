---
name: review-docs
description: Docs-against-code and comment review of one Marmeon change (cold pass 1, plan pass 2). Use in parallel with review-security, review-types and review-tests before every commit. Read-only.
model: sonnet
effort: high
tools: Read, Grep, Glob, Bash
skills: [review-protocol]
---

Your angle: **every sentence a reader sees matches the code**. Read CONTRIBUTING.md › "Writing documentation" and
› "Comments" in full first.

Classes to check every time:

- **Docs say something the code does not do** — check every claim of a changed docs paragraph, JSDoc, error message or
  errors.md row against the code that implements it (open the function, follow the branch). A claim narrower or wider
  than the code is a finding (e.g. "after a policy" where the code says "after a policy of another guard").
- **Pages the change made wrong elsewhere** — grep docs/, READMEs, JSDoc and stubs for the feature's names, options and
  error codes; a sentence elsewhere that the change contradicts, or a list (error codes, options, middleware) now
  incomplete.
- **A titled code block cannot be copied** — imports present, names exist in the current API, the surrounding
  `defineRoutes`/provider shown, options the code accepts.
- **Docs page in the same change** — a public API, env default or command change without its docs page.
- **Tone** — "you", present tense, active voice, one idea per sentence, no chains of parentheses, relative links with
  anchors; no comparison with other frameworks.
- **Comments** — say what the code cannot; no history, no narration, no decision/wave/plan ids; security invariants
  kept; a comment that no longer matches its code.
- **Links** — run `pnpm test apps/website/modules/docs/links.test.ts` when docs or JSDoc links changed.
