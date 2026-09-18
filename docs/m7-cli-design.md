# M7.x Guided Interactive CLI Design

## Purpose

Provide one understandable terminal workflow for recurring Bandcamp-to-TIDAL
refreshes without introducing a second synchronization engine. The guided CLI
orchestrates the existing scan, review, plan, apply, status, and diagnostics
services. Direct subcommands remain available for automation and advanced use.

## Product Decision

The first public entry point is:

```text
bandcamp-tidal-sync guided
```

In a later slice, the installed binary may treat a bare command in an
interactive TTY as an alias for `guided`. A bare command in a non-TTY must never
prompt; it keeps deterministic automation behavior and prints the next command
when appropriate. The existing `bun run sync -- <command>` wrappers remain
compatible.

## User Outcome

A user can run one command and:

1. See the selected configuration, database, account, last run, and pending
   work.
2. Run an incremental read-only refresh.
3. Understand the exact delta: new, changed, and removed Bandcamp items,
   newly matched items, items needing review, items not found, already-saved
   albums, proposed additions, elapsed time, and provider writes.
4. Review uncertain matches without opening JSON files.
5. Create, inspect, and export an immutable dry-run plan.
6. Stop with an explicit statement that TIDAL was not changed.
7. Enter the separate apply flow only deliberately.

## Guided Home

The first screen is a status summary, not a blank prompt:

```text
Bandcamp → TIDAL
Database: ./output/data.sqlite
Last refresh: 2 hours ago (+1 new, 1 removed)
Pending review: 3
Proposed additions: 29
Last run: completed

1. Refresh now (read-only)
2. Review pending matches
3. Preview additions
4. Open an existing plan
5. Status and diagnostics
6. Setup and authorization
q. Quit
```

Every action shows its equivalent direct command in a footer or confirmation
screen. This keeps the guided flow discoverable without making it the only
interface.

## Refresh Flow

The refresh screen explicitly labels each phase:

```text
Step 1/3  Checking configuration
Step 2/3  Updating Bandcamp wishlist (read-only)
Step 3/3  Reusing cached matches and checking TIDAL library (read-only)
```

On completion it shows:

```text
New Bandcamp albums: 1
Changed: 0
Removed: 1
New matches in TIDAL: 1
Needs review: 0
Not found: 0
Already saved: 0
Proposed additions: 1
Elapsed: 11 seconds
Provider writes: 0
```

The refresh uses M7.0 incremental behavior. It must not silently fall back to
a full match scan except where the existing correctness rules require it.
Progress is visible in a TTY and is written to stderr when JSON output is
requested; JSON stdout remains machine-readable.

## Review Flow

Review displays one item at a time with Bandcamp source data, TIDAL candidate
data, score, explanation, edition information, and whether the candidate is
already in the current TIDAL collection. The actions use plain language:

- **Approve**: accept this candidate into the future plan; no provider write.
- **Reject**: this candidate is wrong; do not propose this candidate again.
- **Defer**: leave the decision for later; keep the item available for review.
- **Unavailable**: the release or source cannot currently be confirmed; do not
  add it.
- **Edit**: save corrected metadata for future matching.
- **Back/Quit**: leave without losing already-persisted decisions.

Decisions are written to SQLite immediately, are reversible through the normal
review commands, and always report `Provider writes: 0`.

## Plan Flow

The plan screen shows the immutable plan ID, provider (`tidal`), collection
(`me`), exact additions, skipped already-saved items, and export path. It ends
with two clearly separated choices:

```text
Stop here (recommended)
Open the separate apply flow
```

No refresh, review, or plan action may call a provider write endpoint.

## Apply Boundary

Apply is not part of the default guided path. It opens a separate screen that
repeats the plan ID, collection, count, and safety warning. It requires the
existing explicit `--apply` boundary and a deliberate confirmation tied to the
plan ID. Interactive mode must not use `--yes` as a confirmation shortcut.

The existing live-library recheck, idempotency, batch audit, stop-on-unknown,
resume, and post-apply verification semantics remain authoritative.

## TTY, Cancellation, and Errors

- Interactive prompts require a TTY and fail clearly when one is unavailable.
- Non-TTY mode never waits for stdin. It emits a deterministic result or an
  actionable command suggestion.
- `q` and `Ctrl+C` stop the current local operation without triggering a
  provider write. Durable state must remain valid and resumable.
- A running refresh is exclusive for the selected database; a second start is
  rejected or coalesced with an explicit message.
- Missing, expired, or under-scoped authorization explains the next command
  (`sync auth tidal`) without requesting raw tokens or cookies.
- Provider errors identify whether retrying is safe and preserve the failure in
  the activity log.
- Terminal width, missing color support, and Unicode limitations must not make
  counts or actions unreadable.

## Architecture Constraints

- Reuse existing application services, `SyncStore`, `ReviewService`, plan/apply
  semantics, `Terminal`, and readline support.
- Do not copy the Perplexity skeleton's raw token/cookie configuration,
  playlist model, mock API, or automatic matched-item writes.
- Do not add `commander`, `prompts`, `ora`, or `cli-table3` solely for this
  feature unless a later measured requirement justifies them.
- The guided CLI and web dashboard are two interfaces over the same services;
  neither owns provider logic.

## Slice Plan

### M7.6 — Workflow contract

Define the state machine, command grammar, output vocabulary, TTY/non-TTY
rules, cancellation behavior, and direct-command parity. Add help text and
contract tests before implementing the full flow.

### M7.7 — Guided read-only workflow

Implement Guided Home, refresh, delta summary, review navigation, plan preview,
and plan export. Cover empty and existing databases, cache reuse, new and
removed Bandcamp items, authorization diagnostics, and zero-write guarantees.

### M7.8 — Guarded apply and recovery

Integrate the separate apply screen with the existing plan ID and `--apply`
boundary. Expose batch progress, retry/resume, unknown outcomes, and
post-apply verification without changing write policy.

### M7.9 — Packaging and acceptance

Document installation and the guided path, add shell completions and examples,
run fixture and mocked-provider acceptance, and perform the real-account
read-only smoke test. Do not perform a real provider write as part of this
gate.

## Non-Goals

- Replacing the direct CLI or JSON automation surface.
- A dependency-heavy full-screen TUI.
- New provider APIs, credentials, playlists, or storage models.
- Automatic approval or silent background writes.
- TIDAL removal synchronization.
- Notifications or scheduling; those remain separate M7 slices.

