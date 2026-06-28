# Harness Init

Target project: `pi` (`F:\AIInfra\pi`).

## Detected Context

- shape: monorepo · languages: typescript, javascript · frameworks: node agent harness (pi-ai, pi-agent-core, pi-tui, pi-coding-agent) · commands: build, check, test · aiTraces: AGENTS.md

## Cursor Command Contract

> HARNESS Cursor init command
This is the only Harness onboarding command. Do not ask the user to run terminal `harness`, `npm install`, or `npm run smart`.
Step 1 — Grounding: establish stacks, frameworks, and AI tool traces from repo inspection.
Step 2 — Read & Judge: read Root_Truth_Files, apply Sanity_Floor / Section_Boundary / Empty_Draft checks.
Step 3 — Draft & Confirm: prepare drafts, present summary, ask one yes/no.
Step 4 — Confirm Write Set: on `yes`, freeze the exact Draft bytes.
Step 5 — Apply: write confirmed files only — no re-grounding, no plan recomputation.
Do not require `.harness/runs/` artifacts or TypeScript maintainer scripts for this command.

## Confirmation Rule

Apply only after the user explicitly confirms in chat. Do not show file-level Plan internals unless the user asks. If the user declines, leave target configuration files unchanged.

## Fork Note

This fork (`manhua-man/pi`) uses harness 事/法/设: `AGENTS.md` (facts + upstream rules), `CLAUDE.md` (protocol), `DESIGN.md` (TUI design). Upstream `earendil-works/pi` may differ.