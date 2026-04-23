<!--
Sync Impact Report
Version change: template -> 1.0.0
Modified principles:
- Template Principle 1 -> I. Local-First Desktop Scope
- Template Principle 2 -> II. Minimal-Footprint UI
- Template Principle 3 -> III. Feed Integrity Before Novelty
- Template Principle 4 -> IV. Additive Evolution
- Template Principle 5 -> V. Test-Backed Behavior
Added sections:
- Product Constraints
- Workflow & Quality Gates
Removed sections:
- None
Templates requiring updates:
- ✅ .specify/templates/plan-template.md
- ✅ .specify/templates/spec-template.md
- ✅ .specify/templates/tasks-template.md
Follow-up TODOs:
- None
-->
# priceViewer Constitution

## Core Principles

### I. Local-First Desktop Scope
The product MUST remain a self-contained desktop market monitor that runs from
local configuration and public market data. Core user value MUST NOT depend on
introducing a backend service, private credentials, or hosted control plane
unless a later spec explicitly approves that expansion. This keeps the product
easy to run, easy to reason about, and reversible if an experiment fails.

### II. Minimal-Footprint UI
The default user experience MUST preserve a compact, low-noise floating window
that is readable in a small corner of the screen. New information density,
controls, and states MUST be transient, opt-in, or clearly justified in the
feature spec. Features that add clutter without improving real monitoring value
are out of bounds.

### III. Feed Integrity Before Novelty
The application MUST treat stale, missing, reconnecting, or placeholder market
data as degraded input and MUST NOT present it as fresh truth. Any feature that
reacts to quotes, including alerting or derived states, MUST define safe
behavior for stale data, reconnects, and partial snapshots before it is
considered ready.

### IV. Additive Evolution
Changes MUST build on the existing `config.py -> bitget.py -> models.py ->
floating.py` pipeline unless a spec explicitly justifies broader restructuring.
Framework swaps, runtime changes, or cross-cutting refactors are disallowed by
default; the repository should evolve through small, understandable increments
that preserve current behavior while adding new capability.

### V. Test-Backed Behavior
Every user-visible behavior change, config rule, parser path, or quote-state
transition MUST have automated verification. Bug fixes MUST add a regression
test. Documentation-only or purely cosmetic wording updates may skip tests, but
behavioral changes may not.

## Product Constraints

- The approved runtime is the current Python desktop application built around
  PySide6 and the existing `terminal_ticker/` package layout.
- The supported market source is Bitget public market data unless a future spec
  explicitly expands scope.
- Core workflows MUST continue to work with local files and without API keys.
- Features MUST preserve current macOS and Linux desktop expectations described
  in the project README.
- New persistence requirements SHOULD prefer local file-based configuration or
  state unless a spec proves that something heavier is necessary.

## Workflow & Quality Gates

- Any non-trivial feature MUST start with a spec under `specs/` before
  implementation work begins.
- If a feature meaningfully changes behavior across more than one module, the
  feature MUST produce a plan and task breakdown before code changes start.
- Specs, plans, and tasks MUST explicitly call out how the feature protects
  compact UI defaults and feed integrity under degraded data.
- Reviews MUST reject work that introduces broad refactors without a written
  justification in the feature plan's complexity tracking section.
- Before merge, the branch MUST have the relevant automated tests run and the
  results recorded in the implementation summary.

## Governance

This constitution supersedes ad hoc workflow preferences for this repository.
Every spec, plan, task list, review, and implementation summary MUST be checked
against these principles. Amendments require either an explicit user request or
a spec/plan that documents why the old rule no longer fits. Versioning follows
semantic versioning: major for incompatible principle changes, minor for new or
materially expanded governance, patch for clarifications. Compliance exceptions
MUST be documented in the relevant feature plan before implementation begins.

**Version**: 1.0.0 | **Ratified**: 2026-04-23 | **Last Amended**: 2026-04-23
