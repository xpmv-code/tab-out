# Domain Docs

This repository uses a single-context domain documentation layout. These rules describe how engineering skills consume it while exploring and changing the codebase.

## Before Exploring

Read these files when they are relevant to the current work:

- `CONTEXT.md` at the repository root.
- ADRs under `docs/adr/` that touch the area being changed.

If these files do not exist, proceed silently. They are created only when domain language or architectural decisions need to be recorded.

## Vocabulary

Use domain terms as defined in `CONTEXT.md` across code, tasks, tests, and documentation. When a required concept is absent, first consider whether an existing term applies; otherwise record the genuine model gap.

## ADR Conflicts

If a proposed change conflicts with an existing ADR, surface the conflict explicitly instead of silently overriding the recorded decision.
