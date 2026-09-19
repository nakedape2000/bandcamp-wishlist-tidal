# M7.x Guided CLI Verification Runbook

The guided CLI is accepted only when the scenarios below pass. Fixture and
mocked-provider tests are mandatory; the real-account check is read-only.

## Automated Gate

Run the slice verification command once it is added. It must include the full
test suite, TypeScript checking, formatting, CLI contract tests, and mocked
provider tests. The default suite must report zero real provider writes.

## Fresh Fixture Flow

1. Start with a new temporary configuration and database.
2. Run `bandcamp-tidal-sync guided` in a TTY.
3. Confirm the Home screen explains the empty state and the next action.
4. Run the fixture refresh.
5. Confirm the phase labels, delta summary, review count, plan preview, and
   `Provider writes: 0`.
6. Quit before apply and confirm the database is valid.

## Existing Database and Incremental Refresh

1. Use a copy of a known database and its matching artifacts.
2. Run the guided refresh with unchanged inputs.
3. Confirm cached matches are reused and no unnecessary full match scan occurs.
4. Add one fixture wishlist album and run refresh again.
5. Confirm exactly one new item is surfaced with its match/review/not-found
   result.
6. Remove one fixture wishlist item and confirm the removal delta is visible.
7. Confirm every read-only run reports zero provider writes.

## Review and Plan

1. Open the pending review queue from Home.
2. Exercise approve, reject, defer, unavailable, choose-candidate, and edit
   metadata on representative records.
3. Quit and restart; confirm decisions persist and the queue and proposed plan
   change accordingly.
4. Create and export a plan.
5. Confirm the plan ID and additions are immutable and inspectable.
6. Confirm no apply action is available as an accidental list-row or default
   refresh action.

## Apply and Recovery (Mock Provider Only)

1. Open apply for a known plan and verify the provider, collection, count, and
   plan ID are repeated.
2. Confirm apply cannot proceed without the explicit apply gate and deliberate
   confirmation.
3. Inject retryable, interrupted, and unknown outcomes.
4. Confirm successful batches are not repeated, unknown outcomes stop the run,
   and resume writes only pending batches.
5. Confirm post-apply verification and audit records remain visible after a
   restart.

## TTY and Failure Behavior

- Run with no TTY and confirm it never prompts or hangs.
- Run with `--json` and confirm stdout is valid JSON while progress stays on
  stderr.
- Test missing, expired, and under-scoped TIDAL authorization.
- Cancel with `q` and `Ctrl+C` at each local step and reopen the database.
- Attempt a concurrent refresh and confirm the user receives a clear message.
- Test narrow terminals, no color, and a failed provider request.

## Real-Account Read-Only Smoke Test

1. Copy the known-good database to a temporary path.
2. Run `sync guided` or the explicit guided command against that copy.
3. Confirm the refresh reports the real delta, cached reuse, review queue, and
   proposed additions.
4. Stop before any apply confirmation.
5. Record `Provider writes: 0` and the elapsed time.

No real TIDAL write is part of this acceptance runbook.

