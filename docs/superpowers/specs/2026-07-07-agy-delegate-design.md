# agy-delegate — Cross-Agent Verification Tool (Design)

**Date:** 2026-07-07
**Status:** Approved by user (brainstorming session)
**Sub-project:** B of 3 (A = verifiability audit report, C = workflow embedding + deterministic gates)

## Problem

Many development workflows in this repo (and generally) are hard to verify: LLM output
quality rests on a single judge with a fabrication history (TRACKER F141), code changes get
only single-model self-review, mechanical batch steps burn expensive Claude tokens, and
end-to-end flows are rarely exercised. A second, independent AI agent can cross-verify
claims, review diffs, debate decisions, and execute cheap mechanical steps.

The Antigravity CLI (`agy`, at `~/.local/bin/agy`) is installed and supports non-interactive
`--print` mode. Empirically verified 2026-07-07:

- `agy --print "<prompt>" --model "Gemini 3.5 Flash (Low)"` returns in ~5 s.
- Default permission mode can **read workspace files** in print mode (~13 s with a file read).
- Available models: Gemini 3.5 Flash (Low/Medium/High), Gemini 3.1 Pro (Low/High),
  Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium).
- Relevant flags: `--print`, `--print-timeout`, `--model`, `--continue`, `--conversation <id>`,
  `--sandbox`, `--add-dir`. The Claude Code permission classifier blocks
  `--dangerously-skip-permissions`; it must never be used.

## Decision Summary

- **Form:** user-level tool (works in any project; wowarenalogs is just the first consumer).
- **Architecture:** thin wrapper script + one skill ("approach 3"). No forwarding agent, no
  job queue — Claude calls the script via Bash directly; long tasks use Claude Code's native
  `run_in_background`.
- **Permissions:** tiered. Read-only roles use agy default print mode; `exec` uses
  `--sandbox`. Never `--dangerously-skip-permissions`.
- **Scope of this spec:** the tool only. The audit report (A) and workflow embedding (C) are
  separate follow-ups.

## File Layout

Self-contained under the user's Claude home so any project can use it:

```
~/.claude/skills/agy/
├── SKILL.md            # single skill covering all roles
└── scripts/agy-run.mjs # thin wrapper, Node, zero dependencies
```

## Wrapper Script CLI

```
node ~/.claude/skills/agy/scripts/agy-run.mjs <role> [flags] "<task>"

roles:  verify | review | debate-open | debate-reply | exec | ask | selftest
flags:  --model <alias>        flash-low | flash | flash-high | pro-low | pro | gpt-oss
                               (each role has a default; aliases map to agy's full names)
        --files <a,b,c>        file paths referenced in the prompt preamble
        --timeout <sec>        default 300; script kills the child on expiry
        --conversation <id>    resume a debate (debate-reply)
        --json                 emit {role, model, verdict, conversationId, output, durationMs}
```

Script responsibilities (the mechanical parts, frozen in code so they are testable):

1. Model alias → full agy model name mapping (full names contain spaces/parentheses and are
   easy to misquote by hand).
2. Prepend the role's output-contract preamble to the task text.
3. Enforce timeout by killing the child process.
4. Exit codes describe **transport only**: `0` = agy ran and printed, `2` = agy missing /
   crashed / timed out, `1` = usage error. Verdict content never changes the exit code.
5. Print a one-line header (role, model, duration, conversation id if known) followed by
   agy's stdout unmodified. With `--json`, wrap instead. The `verdict` field is extracted
   textually: first line matching `VERDICT: …` for `verify`, trailing `APPROVE` /
   `REQUEST_CHANGES` line for `review`, `null` for other roles or when absent.
6. Unknown model alias → error listing valid aliases; agy binary missing → clear install hint.
7. No automatic retries; report failures as-is.

## Role Contracts (preambles baked into the script)

| Role                           | Contract                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`                       | Independent verifier. First line MUST be `VERDICT: CONFIRMED\|REFUTED\|INCONCLUSIVE`, followed by evidence (`file:line`) and a description of what was actually checked. For load-bearing claims ("the root cause is X", "this change does not break Y"). |
| `review`                       | Independent code reviewer. Findings ranked by severity, each with `file:line` and a concrete failure scenario. Last line `APPROVE` or `REQUEST_CHANGES`.                                                                                                  |
| `debate-open` / `debate-reply` | Devil's advocate. Attack the claim, steelman alternatives. Multi-round via agy conversation resume: Claude states position → agy rebuts → Claude responds (`debate-reply`) → agy issues final judgment.                                                   |
| `exec`                         | Execute exactly the given steps; do not improvise; report each step's result.                                                                                                                                                                             |
| `ask`                          | Raw passthrough, no preamble.                                                                                                                                                                                                                             |
| `selftest`                     | Runs a canned `verify` case against a fixture; asserts the `VERDICT:` first line and exit code.                                                                                                                                                           |

**Debate conversation id:** implementation must determine whether a print-mode run exposes
its conversation id (for `--conversation`). If not obtainable, `debate-reply` falls back to
`--continue` (most recent conversation) and prints a warning that concurrent agy runs can
corrupt the thread.

## Model Routing & Independence Rules

| Role            | Default model             | Rationale                                                  |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| verify / exec   | Gemini 3.5 Flash (Medium) | cheap, fast; tasks are mechanical                          |
| review / debate | Gemini 3.1 Pro (High)     | second opinions need a genuinely strong, independent model |

Hard rule (stated in SKILL.md and enforced as the default): when cross-checking Claude's own
work, **never route to agy's Claude-family models** — same-family correlation defeats the
purpose of independent verification. Claude-family models via agy are permissible only when
the user explicitly asks.

## Permission Tiers

- `verify` / `review` / `debate-*` / `ask`: agy default print mode. Read-only in practice;
  output is a report, never file changes.
- `exec`: adds `--sandbox`. Implementation must empirically test what sandboxed print mode
  can actually do (write files? run commands?). If it cannot write, `exec` degrades to
  "produce an exact patch/text output that Claude reviews and applies itself".
- `--dangerously-skip-permissions` is banned unconditionally.

## SKILL.md Contents

- When to trigger each role proactively: nontrivial code change → `review`; load-bearing
  claim → `verify`; design fork → `debate`; mechanical batch steps → `exec`.
- How to interpret results: agy's `REFUTED` is not a final ruling — it obliges Claude to
  answer with evidence (or concede); `INCONCLUSIVE` means the claim needs a deterministic
  check instead.
- Model routing defaults + the independence rule.
- Use `run_in_background` for tasks expected to exceed ~2 minutes.
- Cost note: Flash roles are cheap enough to use liberally; Pro roles reserve for real
  decisions.

## Error Handling

Covered by script responsibilities 4–7 above. The skill instructs Claude: on exit code 2,
report the failure to the user rather than silently proceeding as if verified.

## Testing

- `selftest` subcommand is the smoke gate (also the tool's own "verifiability" dogfood).
- Manual smoke commands documented in SKILL.md.
- Implementation-phase empirical checks: conversation-id discovery, `--sandbox` write
  capability, behavior when agy prompts for permission in print mode.

## Out of Scope

- Verifiability audit report (sub-project A).
- Embedding agy calls into this repo's eval trust chain / review habits, and any new
  deterministic verification gates (sub-project C).
- Background job management, forwarding agents, marketplace packaging.
