# M7 Design: Local Sync Dashboard

## Purpose

M7 turns the existing review desk into a small local operations dashboard for
recurring Bandcamp-to-TIDAL synchronization. The dashboard is an interface to
the existing application services; it is not a second sync engine and it never
weakens the CLI safety boundary.

The reader of this document should be able to implement one vertical slice,
verify it locally, and know which actions may contact a provider.

## User Outcome

A user can open the local dashboard and answer four questions without reading
raw JSON or database tables:

1. When did the last scan run, and did it finish successfully?
2. Which matches need a decision?
3. What would the next immutable plan add?
4. What failed, and what is safe to retry?

The user can then explicitly start a read-only scan, review decisions, create a
plan, inspect that plan, and deliberately apply that exact plan.

## Safety Contract

- The server binds to `127.0.0.1` by default.
- Browser code never receives provider tokens or client secrets.
- `Scan now`, review actions, and `Create plan` perform zero provider writes.
- `Apply approved plan` is visually and technically separate from read-only
  actions and requires the existing `--apply` confirmation boundary.
- A plan is immutable. A changed library or changed decisions produce a new
  plan rather than silently mutating an old one.
- Unknown provider outcomes stop the apply operation and remain visible as a
  failure requiring inspection.
- Every dashboard mutation is attributable to a local operation and appears in
  the activity log.
- Remote access is out of scope unless an authenticated reverse proxy and an
  explicit warning are configured.

## First-Run Flow

```text
Dashboard
  ├─ status summary
  ├─ Scan now (read-only)
  ├─ Review matches (decisions only)
  ├─ Create plan (immutable, dry-run)
  └─ Apply approved plan (explicit write boundary)
```

The default landing view is the status summary. If no scan has run, it shows a
clear empty state with the setup and scan prerequisites, not a misleading zero
result. If a scan is running, the dashboard shows progress and disables actions
that would race with that run.

## Dashboard Sections

### Run summary

Show the last run status, start and finish time, source item count, match count,
review count, proposed addition count, write count, and failure count. Show the
next scheduled scan only when scheduling is enabled.

### Review queue

Reuse the M3 review desk. Keep filtering, candidate evidence, decision history,
metadata edits, and the `Provider writes: 0` signal. A decision updates the
queue and pending-plan count without starting a provider write.

### Plan preview

Show the immutable plan identifier, creation time, current library snapshot
count, exact additions, skipped already-saved items, and the plan status. The
preview must provide an export/download action. It must not contain an apply
control that can be triggered accidentally from a list row.

### Apply view

The apply view is a separate, conspicuous action. It repeats the plan identifier,
addition count, and target collection, requires an explicit confirmation, and
shows live progress, batch results, unknown outcomes, and post-apply
verification. The default remains dry-run.

### Activity and reports

List scans, decisions, plan creation, apply attempts, verification results,
failures, and exports in reverse chronological order. Each entry links to a
downloadable JSON report. Reports contain counts, identifiers, timestamps, and
error details, but never tokens or cookies.

## Vertical Slices

### M7.1 Dashboard read model

Add a read-only dashboard summary backed by the existing SQLite state and a
stable JSON response. Include last run, pending reviews, proposed additions,
failures, and library snapshot information. Add loading, empty, stale, and
error states.

**Depends on:** M1 state and M3 review data.

### M7.2 Read-only actions

Add `Scan now`, `Review matches`, and `Create plan` actions. Scan invokes the
existing incremental read-only workflow. Create plan persists an immutable plan
and returns its identifier. All three actions expose operation status and are
idempotent or safely reject a conflicting run.

**Depends on:** M7.1 and M4 plan semantics.

### M7.3 Explicit apply flow

Add a separate plan detail and apply confirmation flow backed by the existing
write orchestrator. Require the plan identifier, explicit confirmation, live
batch progress, stop-on-unknown behavior, and post-apply verification.

**Depends on:** M7.2 and M4 apply semantics.

### M7.4 Recovery and operations

Add activity logs, downloadable reports, health/readiness endpoints, and
database plus decision backup/export. Make interrupted operations visible and
resumable without duplicating provider writes.

**Depends on:** M7.1–M7.3 and M5 reporting commands.

### M7.5 Opt-in scheduling

Add a visible next-run time, schedule validation, pause/resume, and read-only
scheduled scans. Notifications are opt-in and must never contain tokens or
private metadata beyond the configured summary.

**Depends on:** M7.4. Notifications may be deferred without blocking the
dashboard release.

## Acceptance Criteria

M7 is accepted only when all of the following are true:

- A fresh local setup can open the dashboard and see a meaningful empty state.
- A fixture scan populates the summary and review queue without network access
  or provider writes.
- `Scan now` cannot run concurrently with another scan and reports completion or
  a durable failure.
- Review decisions persist after refresh and change the pending plan count.
- `Create plan` shows an immutable identifier and exact additions; repeating it
  with unchanged state is idempotent.
- A plan can be exported and inspected before any apply action.
- No dashboard action except the explicit apply flow can contact a provider
  write endpoint.
- Apply requires explicit confirmation, records each batch, stops on unknown
  outcomes, and verifies the resulting library.
- The dashboard shows the last successful run, pending reviews, proposed
  additions, failures, and next schedule when configured.
- Health/readiness responses distinguish a healthy idle service from a service
  whose database or active run is unavailable.
- Backups and reports are restorable and contain no credentials.
- Browser requests reject missing session or CSRF credentials for mutations.
- The local acceptance runbook passes on macOS and Linux with provider writes at
  zero; the mocked apply test is the only apply test in the default suite.

## Non-Goals

- Hosted multi-user access or public deployment.
- Automatic approval of ambiguous matches.
- Silent background writes.
- Deletion from TIDAL when an item leaves Bandcamp.
- Notifications before the dashboard and recovery paths are stable.
- Replacing the CLI as the canonical automation surface.

## M8 Handoff

M8 may start after M7 acceptance demonstrates that provider-neutral services,
provider adapters, and the dashboard do not depend on one another's private
implementation details. A future provider should be addable through the
documented adapter contract without changing review, plan, or audit semantics.
