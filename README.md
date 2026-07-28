# Matt Flow for pi

A pi package that turns Matt Pocock's engineering skills into a resumable idea-to-ship state machine.

## Install

Review the source first: pi extensions run with your full system permissions.

```bash
pi install git:github.com/maxbin123/pi-matt-flow
```

Then restart pi, or run `/reload` in an existing process.

### Prerequisites

Install [Matt Pocock's skills](https://github.com/mattpocock/skills), including `setup-matt-pocock-skills`, `grill-with-docs` or `grill-me`, `to-spec`, `to-tickets`, `implement`, and `code-review`. The `wayfinder` route additionally requires the `wayfinder` skill.

## Start

```text
/matt-flow Build project-scoped API tokens
/matt-flow --main --docs Build project-scoped API tokens
/matt-flow --wayfinder Redesign the platform's authorization model
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
- Each Standards/Spec review axis runs as a separate ephemeral `pi --no-session` subprocess through the included `Agent` compatibility tool. Parallel `Agent` calls therefore have isolated context windows.

The installed Matt bundle currently has no `/research` skill. Wayfinder remains usable for non-research decision tickets and warns on startup; install `/research` separately before relying on Wayfinder's automatic research-ticket branch flow.

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
