# Spec-Driven Development (SDD)

No plan is drafted without analysis, and no production code without an approved spec.

## States

`pending → analyzing → needs_clarification → spec_ready → approved → in_progress → done` (or `blocked`).
Only one feature is **active** (`analyzing` or `in_progress`) at a time. Any number of features may sit at `approved`, waiting to be implemented.

## Flow

0. **Brainstorm (epic, recommended)** — `/brainstorm <idea>` turns a rough idea into a set of discrete features. The leader proposes a breakdown (slugs, titles, `dependsOn`, order), writes it to `progress/brainstorm_<epic>.md`, and **stops for human approval**. On approval it registers each feature as `pending` via `reins add-feature`, then drives each one through steps 1–4 below **feature by feature, inside the brainstorm**: discovery, open questions answered in chat, spec drafted, spec approved. The epic ends with every feature `approved` — all human questioning is front-loaded here, and implementation later runs without further gates.
1. **Discovery (leader)** — for a `pending` feature, the leader sets it `analyzing` and investigates the codebase (reads code, launches explorers), then writes `specs/<feature>/discovery.md`: findings, affected areas, approaches, and the **open questions** a human must answer. The feature becomes `needs_clarification` and work **stops**. A bare title is never enough to plan from.
2. **Validate (human)** — a human answers the open questions; the leader records them in the discovery's **Resolution**. Use `/validate-discovery <feature>` (or answer in chat during `/brainstorm`).
3. **Draft (spec_author)** — grounded in the validated discovery, `spec_author` writes:
   - `requirements.md` — `R1..Rn` in EARS notation ("WHEN/WHILE/IF … the system SHALL …").
   - `design.md` — files to touch, signatures, data shapes, and one rejected alternative.
   - `tasks.md` — `T1..Tn` covering every requirement, with a `T → R → test` table.

   The feature becomes `spec_ready`.
4. **Approve (human)** — a human reads the spec and approves; the feature becomes `approved`. Use `/approve-spec <feature>` (or approve in chat during `/brainstorm`). Implementation has not started yet.
5. **Implement** — `/next-feature` takes an `approved` feature whose dependencies are `done`, sets it `in_progress`, and implements with **no further questions or approvals** — one feature per invocation. `implementer` builds strictly to the spec, ticking off tasks and writing a test per requirement.
6. **Review** — `reviewer` verifies traceability: every `R<n>` has a test, or the change is rejected.

`reins verify` enforces this: a feature in `needs_clarification`, `spec_ready`, `approved`, or `in_progress` must have a `discovery.md`; an `approved` feature must also have its full spec (`requirements.md`, `design.md`, `tasks.md`); only one feature may be active at a time; and `dependsOn` is honored — no cycles, no dangling references, and a feature cannot be `in_progress` or `done` until every dependency is `done` (`approved` may be held while waiting on dependencies).

All spec artifacts (`discovery.md`, `requirements.md`, `design.md`, `tasks.md`) are written in English, regardless of the conversation language.

## Why

Two human gates — one on **intent** (discovery) and one on **the plan** (the spec) — so misalignment is caught on paper, before a single line of code. For an epic, both gates are front-loaded into `/brainstorm`, so execution flows uninterrupted. Traceability is the difference between "green" and "correct".
