---
name: review-protocol
description: How a Marmeon review pass runs (cold pass 1, plan pass 2), what it may touch, and the reply format. Preloaded by the review-* agents.
---

# Review protocol

You review one change in Marmeon from one angle — your agent file names it. Other reviewers cover the other angles in
parallel, so stay inside yours: a finding outside it only if it is a blocker you cannot miss. You do not edit tracked
files. Bash is for `git diff`, `git log`, reading, targeted tests (`pnpm test <file or package>`, never full suites —
other agents test in parallel) and throwaway probes in your temporary directory, deleted afterwards.

## Pass 1 — cold

The first message gives only where the change is (worktree path, base or range). No plan, no implementer report, no
hypotheses — do not go looking for them.

1. `git rev-parse --show-toplevel` must print the given worktree; stop otherwise.
2. Read the whole diff, untracked files included (`git status --short`, `git diff <base>`).
3. Read `<worktree>/AGENTS.md` › "Review guidelines" (the worktree's copy, not another checkout's) and apply its
   classes and the rules by path that match the diff, and read the CONTRIBUTING.md sections your angle
   needs (`grep -n '^#' CONTRIBUTING.md`, then those sections whole).
4. Work through every class of your agent file on every changed symbol, paragraph, test and error path. Prove a claim
   instead of reasoning about it: compile the probe, run the test, grep the other pages.
5. A defect found in one place: check every sibling the change touches for the same defect (the other commands,
   middleware, options or methods built the same way) and list each place.
6. Reply with `Pass 1` findings, then stop.

## Pass 2 — against the plan

A follow-up message brings the plan step (or the path of a file holding it) and questions. Check the change against it, answer each question, and re-check
what the plan made you see differently. Plan conformance never excuses a pass-1 defect; a hole in the plan is a finding
against the plan. List only what is new or changed since pass 1, then the answers.

## Reply

```
Pass 1 | Pass 2 — <angle>
Verdict: APPROVE | CHANGES
1. [blocker|major|minor] [class] path:line — the defect, how you verified it, the concrete fix
…
Checked, no finding: <one line per class you covered>
```

An edge case is never dismissed as "negligible" without naming its concrete consequence (what breaks, for whom); if
you can name one, it is a finding. Only verified findings, most severe first, at most 10. No praise, no diff summary, no style nits no rule backs. The
"Checked" lines let the orchestrator see which classes you actually covered.
