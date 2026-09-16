# M7 Verification Runbook

This runbook proves the dashboard workflow while keeping the default test path
read-only. The mocked apply section uses a fake provider and never contacts
Bandcamp or TIDAL.

## 1. Automated gate

Run `bun run verify:m7` after the current slice adds that script. It must cover
the project tests, type checking, formatting, and browser/API tests for the
slice. The slice is not accepted when any command fails.

Expected safety signal: the suite reports zero real provider writes. A mocked
provider write is allowed only in the isolated apply test.

## 2. Fresh empty state

Start the local dashboard against a new temporary database and open it on the
loopback address. Verify:

- the listening socket is bound only to `127.0.0.1` (or `::1`), not a wildcard
  or LAN address;
- remote access is disabled by default and becomes available only after an
  explicit advanced configuration with the documented warning;
- the dashboard loads without credentials in client-side JavaScript;
- the empty state explains that no scan has run;
- summary counts are zero without looking like a failed request;
- health reports idle and ready;
- mutation requests without the session cookie are rejected;
- mutation requests with the session cookie but without the CSRF token are
  rejected;
- the browser console has no errors.

## 3. Fixture scan and review

Load the minimized fixture dataset into a disposable database and use `Scan now`.
Verify:

- the operation is visibly running and then completes;
- the summary shows source items, matches, pending reviews, and proposed
  additions;
- a second click while the scan is running is rejected or coalesced safely;
- no provider write endpoint is called;
- a review decision survives a page refresh;
- pending additions change when a candidate is approved or rejected;
- an injected scan failure remains visible after a refresh and a server restart,
  including enough information to distinguish it from a successful empty scan.

## 4. Plan preview

Choose `Create plan`, inspect the returned plan identifier, and download the
report. Verify:

- the plan lists exact additions and skipped already-saved items;
- the plan is immutable after it is created;
- repeating `Create plan` with unchanged state reuses the same plan identifier
  and leaves the persisted plan count unchanged, or is safely rejected without
  adding another plan;
- the preview has no accidental apply control;
- the report contains no token, cookie, or authorization header.

## 5. Mocked apply and recovery

Run the apply flow against a fake provider with deterministic responses. Verify:

- apply is unavailable until an explicit confirmation is given;
- each batch records its idempotency key and response audit;
- a retryable failure resumes only pending batches;
- an interruption between batches remains visible after server restart, and
  resuming it writes only pending batches without repeating completed batches;
- an unknown outcome stops the plan and requires inspection;
- post-apply verification detects a missing album;
- repeating a completed plan performs zero duplicate writes.

## 6. Reports, backup, and health

Export the activity report, decisions, and database backup to a temporary
directory, restore them into a second disposable database, and reopen the
dashboard. Verify that decisions, counts, and plan history remain available.
Scan every exported artifact and restored record for provider tokens, client
secrets, cookies, authorization headers, and OAuth codes; none may be present.
Check that readiness becomes unhealthy when the database is unavailable and
returns to ready after recovery.

## 7. Scheduling

Enable a short test interval in a disposable configuration. Verify:

- the next-run time is visible and uses the configured timezone;
- a scheduled scan is read-only and appears in the activity log;
- pause and resume work;
- a malformed schedule is rejected before it starts a run;
- notifications are absent unless explicitly enabled.

## 8. Real-account smoke test

After M6 release acceptance, run one read-only scan against the user's real
Bandcamp and TIDAL accounts. Confirm the dashboard counts and review queue match
the CLI reports. Stop before any apply confirmation. A real write requires a
separate, user-approved exercise and is never part of the default M7 gate.

M7 is accepted only when every section above has a recorded result. Fixture,
mocked-apply, and real-account checks use different data, but must demonstrate
the same invariants: read-only actions perform zero provider writes, state
transitions are valid and durable, reports use the same schema and semantics,
and credentials never appear in browser responses or exported artifacts.
