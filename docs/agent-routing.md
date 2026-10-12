# Agents

Four subagents, one rule: **every one is a 5.5 model**. The main thread runs
Sonnet 5.5, and nothing here falls back to an older family.

| agent | model | effort | use it when | tools |
|---|---|---|---|---|
| `scout` | Sonnet 5.5 | low | the answer is a fact to look up — grep, read a log, fetch a doc page | read-only |
| `worker` | Sonnet 5.5 | medium | the change is decided and mostly mechanical — implement, run a test loop, draft a PR body | all, **no commit/push** |
| `reviewer` | Opus 5.5 | high | before a large change is pushed, or when a claim is about to be asserted unverified | read + run, never edits |
| `architect` | Opus 5.5 | xhigh | root cause has resisted two attempts, or a wrong design choice would be expensive | read + run, never edits |

The main thread decides when to spawn one. The test is whether it **saves main
context** or **gives an independent second view** — not whether it looks like
division of labour. A one-file read, or anything that needs the conversation's
context, stays on the main thread.

## Calling them — do not pass `model`

The models are pinned here by **full ID** (`claude-sonnet-5-5`,
`claude-opus-5-5`). The `Agent` tool's own `model` parameter only takes the
aliases `sonnet` / `opus` / `haiku` / `fable`, and a per-invocation value is
resolved **before** the definition's — so passing one would override the pin
with whatever the alias currently resolves to. Pick the agent by
`subagent_type` and leave `model` out.

Resolution order, from the docs: per-invocation `model` → frontmatter `model`
→ `CLAUDE_CODE_SUBAGENT_MODEL` → the main conversation's model.

`effort` has no invocation parameter in the `Agent` tool, so the definition is
the only place it can be set. It overrides the session's effort but not the
`CLAUDE_CODE_EFFORT_LEVEL` environment variable — if that is set, it wins over
all of these.

## What a subagent's report is

**Unverified input.** It is a model's account of what it found. Anything that
will affect a commit — a diagnosis, a "this is fixed", a count — is re-checked on
the main thread before it is relied on. The agents are told to report evidence
(file and line, the command and what it printed) rather than conclusions
precisely so that this is cheap.

## Limits that are written into the definitions

`worker` may not commit, push, stash, `git add -A`, or touch `CLAUDE.md`,
settings or anything under `.claude/`. `reviewer` and `architect` do not edit
tracked files. These are instructions, not sandboxing — `Bash` can do more than
the prose allows, so they are also the first thing to check in a report.
