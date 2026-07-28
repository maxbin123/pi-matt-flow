# Matt Flow for pi

A pi package that turns Matt Pocock's engineering skills into a resumable idea-to-ship state machine, with [pi-flow](https://github.com/kky42/pi-flow) providing fresh Pi, Codex CLI, and Claude Code subagents.

## Install

Review the source first: pi extensions run with your full system permissions.

```bash
# Follow the default branch
pi install git:github.com/maxbin123/pi-matt-flow

# Or pin the first release
pi install git:github.com/maxbin123/pi-matt-flow@v0.1.0
```

Then restart pi, or run `/reload` in an existing process.

### Prerequisites

Install [Matt Pocock's skills](https://github.com/mattpocock/skills), including `setup-matt-pocock-skills`, `grill-with-docs` or `grill-me`, `to-spec`, `to-tickets`, `implement`, and `code-review`. The `wayfinder` route additionally requires `wayfinder` and `research`.

`@kky42/pi-flow` is bundled by this package. Do not install a second standalone copy, because both copies would register `Agent` and `workflow` tools.

For external backends, install and authenticate the corresponding CLI:

```bash
codex login
claude auth login
```

## Start

```text
/matt-flow Build project-scoped API tokens
/matt-flow --main --docs Build project-scoped API tokens
/matt-flow --wayfinder Redesign the platform's authorization model
/matt-flow --implement-with codex --review-with cross Build project-scoped API tokens
/matt-flow --implement-with claude --review-with codex Build project-scoped API tokens
```

Without flags, the command asks which Ask Matt route to use:

- **Main flow:** `grill-with-docs` (or `grill-me`) → `to-spec` → `to-tickets` → `implement` once per ticket → final integration `code-review`
- **Wayfinder:** chart a map → resolve one decision ticket per fresh session → `to-spec` → the main flow

If `docs/agents/issue-tracker.md` is absent, the extension runs `setup-matt-pocock-skills` first.

## Fresh-context boundaries

The extension follows `ask-matt` and `wayfinder` context hygiene:

- Grilling, spec synthesis, and ticket creation stay in one unbroken pi session.
- Every implementation ticket starts in a **new pi session** and receives only the durable workflow state and that ticket's tracker id.
- Every Wayfinder decision ticket starts in a **new pi session**; no session resolves more than one.
- The final integration review starts in a **new pi session**.
- Each Standards/Spec review axis runs as a separate fresh pi-flow `Agent` call with no `session_key`, so the axes remain isolated.
- A Codex or Claude implementation agent gets a stable per-ticket `session_key`; review fixes continue that same specialist context without contaminating independent review contexts.

The implementation ticket's fixed point is captured immediately before its fresh session. The final review fixed point is the commit at which `/matt-flow` started.

## Commands

- `/matt-flow [flags] <idea>` — start
- `/matt-flow-status` — show phase and captured tracker ids
- `/matt-flow-resume` — resume a paused flow
- `/matt-flow-cancel` — cancel orchestration without changing git/tracker artifacts
- `/matt-flow-advance` — internal session-transition command

Flags:

- `--main` / `--wayfinder`
- `--docs` / `--grill-me`
- `--implement-with pi|codex|claude`
- `--review-with pi|codex|claude|cross`

`cross` assigns Standards review to Codex and Spec review to Claude. Without flags, the interactive command asks for both choices.

## pi-flow integration

Matt Flow owns the phase state machine and interactive fresh-session boundaries. pi-flow owns the subagent seam: profiles, Pi/Codex/Claude spawning, bounded concurrency, cancellation, telemetry, rendering, and `session_key` continuation.

When an external backend is selected, Matt Flow installs these profiles under `~/.pi/agent/subagents/` if they are missing, without overwriting existing files:

- `matt-codex-implementer`
- `matt-claude-implementer`
- `matt-codex-reviewer`
- `matt-claude-reviewer`

Run `/matt-flow-install-profiles` to install them explicitly.

The bundled pi-flow `workflow` tool is also available for additional trusted, read-only fan-out. Matt Flow does not use it for its main state machine because grilling, Wayfinder decisions, and ticket progression contain human gates and cross-session transitions.

> **Security:** pi-flow runs Codex and Claude external backends with their approval/sandbox checks bypassed. Use external implementation agents only in repositories you trust. Review profiles are instructed to remain read-only, but they still run through those privileged CLIs.

## Milestone tool

The model reports milestones through `matt_flow`. In particular, `tickets_created` requires every canonical ticket id and its exact blocking ids. This is how the extension preserves the dependency graph and selects the next frontier ticket.

A ticket cannot advance unless:

- the full verification and Matt `code-review` flow ran;
- valid Standards and Spec findings were fixed;
- changes were committed;
- the tracker ticket was updated/closed;
- the git worktree is clean.

After all tickets, the extension reviews the entire flow diff again, fixes integration findings, and only then marks the flow done.

## Development

Load a checkout without installing it:

```bash
pi --no-extensions -e ./extensions/matt-flow/index.ts
```

Smoke-test extension loading:

```bash
npm run check
```
