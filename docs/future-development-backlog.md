# Bandcamp → TIDAL Sync
## Public Product Backlog and Development Plan

**Status:** M9 complete; M10+ planned
**Date:** 2026-09-18
**Project:** `bandcamp-tidal-sync`

## Vision

Build a self-hosted, open-source tool that periodically discovers albums saved on Bandcamp, matches them against TIDAL, and—only after explicit user approval—adds safe, high-confidence matches to the user’s TIDAL collection.

The tool should be useful as:

- a stable CLI for automation, diagnostics, and advanced workflows;
- an optional local web interface for visual review and one-click workflows;
- a reusable public project that other people can configure with their own credentials and data;
- a cautious synchronization utility rather than an uncontrolled “copy everything” automation.

## Current baseline

The first end-to-end workflow is working:

- Bandcamp wishlist export and TIDAL catalogue matching are implemented.
- TIDAL collection export works through the paginated `userCollectionAlbums/me/relationships/items` relationship.
- TIDAL collection writes work through `POST /v2/userCollectionAlbums/me/relationships/items`.
- OAuth now requests both `collection.read` and `collection.write`.
- A ten-album pilot was successfully added and verified.
- The remaining 190 high-confidence albums were added in resumable batches.
- Local JSON and CSV artifacts provide an audit trail.
- `needs_review`, `low_confidence`, and `search_miss` records are excluded from automatic writes.

The current implementation is script-oriented and should be refactored before public release.

## Product principles

1. **Safe by default.** Reading and matching may be automated; writing requires explicit approval.
2. **User-owned credentials.** Credentials stay local or in a user-controlled secret store and are never committed.
3. **Auditable actions.** Every candidate, decision, request, response, retry, and verification result should be explainable.
4. **Idempotent synchronization.** Re-running a sync should not create duplicate work or unexpected changes.
5. **Resumable operations.** Network failures, expired tokens, and interrupted runs should not force a restart.
6. **Human review for ambiguity.** The system should expose uncertain matches instead of hiding them.
7. **Provider boundaries.** Bandcamp and TIDAL integrations should be isolated behind adapters so the core engine remains testable and extensible.
8. **Public-project hygiene.** Documentation, security controls, fixtures, tests, licensing, and contribution guidance are release requirements—not polish.

## Target user workflow

```text
sync init
  → configure providers and local storage
sync auth tidal
  → complete OAuth and store encrypted/local token data
sync scan
  → import Bandcamp wishlist and search TIDAL
sync review
  → approve, reject, or defer ambiguous candidates
sync plan
  → show exactly what would change
sync apply
  → require explicit confirmation, then write approved matches
sync verify
  → re-export TIDAL and report the resulting state
sync status
  → show history, pending reviews, failures, and last successful run
```

The same operations should be available through a local web UI. The CLI remains
the stable automation and recovery surface; new user-facing workflow work is
prioritized in the web UI.

# Milestones

## M-1 — Baseline, privacy, and reproducibility

**Goal:** Establish a safe, known-good baseline before refactoring the current
personal scripts into a public product.

**Status:** Complete

### Tasks

- Inventory the current input files, generated outputs, manifests, and result
  files; document which are sources of truth and which are derived artifacts.
- Freeze a known-good end-to-end snapshot and record the expected counts and
  statuses for future regression checks.
- Audit the Git history and working tree for tokens, OAuth codes, private
  metadata, and other credentials; remove or rewrite sensitive material before
  public release when necessary.
- Keep personal wishlist, match, library, and token artifacts out of the public
  repository; replace real fixtures with minimized or anonymized examples.
- Define versioned schemas for imported JSON, generated reports, and manifests
  (starting with `schema_version: 1`).
- Add a fixture-only end-to-end dry run that requires no network access,
  credentials, or live provider accounts.
- Document the supported local development environment: Bun version, operating
  systems, test commands, temporary-directory requirements, and file-permission
  expectations.

### Acceptance criteria

- A fresh clone can run the fixture-only workflow on macOS and Linux without
  provider credentials.
- The baseline snapshot can be regenerated and compared without contacting
  Bandcamp or TIDAL.
- No token, OAuth code, or private personal dataset is required for CI.
- Every persisted artifact has an owner, schema version, and documented
  retention/privacy expectation.

## M0 — Stabilize the current scripts

**Goal:** Make the current personal workflow reproducible before adding product features.

**Status:** Ready for acceptance. The shared HTTP, configuration,
secret-permission, diagnostic, fixture-test, import, and write-safety foundations
are in place. Bandcamp API calls and TIDAL library export use the shared client;
pilot and resumable bulk writers use protected audit files, deterministic batch
keys, dry-run-by-default gates, and the shared retry/error policy. Compatibility
wrappers remain available; live `--apply` writes are deliberately outside the
M0 acceptance runbook.

### Tasks

- Create a clear repository structure:
  - `src/cli`
  - `src/core`
  - `src/providers/bandcamp`
  - `src/providers/tidal`
  - `src/storage`
  - `src/review`
  - `tests`
  - `fixtures`
  - `docs`
- Extract shared code for HTTP, retries, pagination, JSON:API resources, token loading, and CSV output.
- Replace hard-coded paths, country code, locale, batch size, and delays with configuration.
- Add a versioned configuration file and schema validation.
- Add structured JSON logging alongside human-readable terminal output.
- Add a migration/import command for the existing `output/` files.
- Preserve the current scripts as compatibility wrappers during refactoring.
- Add a `doctor` command that checks Bun/Node version, environment variables, token scopes, file permissions, and provider connectivity.
- Add a shared safety layer for all write-capable commands: dry-run by default,
  explicit confirmation, maximum additions per run, and refusal to continue on
  ambiguous outcomes.
- Persist request payloads, response status/body hashes, retries, timestamps, and
  stable idempotency keys before any provider write.
- Require a live-library recheck before every write batch and run verification
  after the plan completes.
- Protect local token, database, and output files with restrictive permissions;
  redact credentials and authorization headers from all logs.
- Add deterministic tests for pagination, retries, 401 refresh, 429 handling,
  malformed responses, duplicate IDs, and interrupted batches.

### Acceptance criteria

- A fresh clone can run a documented dry-run using fixture data.
- Existing manifests and result files can be imported without manual editing.
- No secret is printed in normal logs.
- All provider requests use one shared retry and error-handling layer.
- A write-capable command cannot make changes without an explicit user-approved
  plan.
- Re-running a fixture-only dry run produces the same plan and zero provider
  writes.
- A failed or interrupted batch can be resumed without re-sending completed
  work.

## M1 — Recurring sync engine

**Status:** Ready for acceptance. The SQLite state store, stable source
IDs/fingerprints, incremental reconciliation, removal markers, sync-run records,
matching/library imports, resumable write-batch records, Bandcamp scan command,
and launchd schedule generator are implemented. Live writes remain opt-in via
`--apply` and are excluded from the acceptance runbook.

**Goal:** Turn the one-time workflow into a repeatable, incremental synchronization process.

The persistent data model must be designed from the canonical domain contracts
and versioned schemas established in M-1/M0, rather than copied directly from
the current script-shaped JSON files.

### Tasks

- Add a persistent local database, preferably SQLite, for:
  - Bandcamp items;
  - normalized artist/title metadata;
  - TIDAL candidate results;
  - match decisions;
  - TIDAL library snapshots;
  - sync runs;
  - write batches;
  - verification results.
- Introduce stable internal IDs and source fingerprints.
- Store `first_seen_at`, `last_seen_at`, `last_scanned_at`, and `last_synced_at`.
- Detect newly added Bandcamp wishlist items since the previous run.
- Detect removed wishlist items without deleting anything from TIDAL by default.
- Add an incremental scan that processes only new or changed Bandcamp records.
- Add a full-rescan command for rebuilding or repairing state.
- Add a configurable schedule through cron, launchd, systemd, or a container scheduler.
- Add a “sync summary” that clearly distinguishes:
  - newly discovered;
  - already matched;
  - already saved;
  - approved and pending write;
  - written;
  - failed;
  - needs review;
  - not found.

### Acceptance criteria

- Running the sync twice without changes produces no writes.
- A new Bandcamp item appears in the next scan and can move through the full workflow.
- An interrupted run resumes from durable state.
- Removing an item from Bandcamp never removes it from TIDAL unless a future destructive mode is explicitly added.

## M2 — Matching quality and cache

**Status:** Ready for acceptance. Deterministic normalization/scoring with
explainable signals, configurable thresholds, alias support, SQLite TTL caches
for search and album metadata, duplicate-edition detection, negative decisions,
durable user overrides, and minimized regression fixtures are implemented.

**Goal:** Reduce API usage while improving confidence and transparency.

Matching behavior is a versioned, deterministic subsystem. Changes to scoring
or thresholds must be evaluable against saved fixtures without re-fetching
provider data.

### Tasks

- Add persistent TIDAL search and album-metadata caches with TTL and source timestamps.
- Add request deduplication within and across runs.
- Add adaptive early stopping when a candidate is clearly superior.
- Normalize Unicode, punctuation, editions, remix markers, catalog numbers, and artist aliases.
- Separate exact, strong, weak, and conflicting signals in match scoring.
- Store a human-readable explanation for every score.
- Add configurable thresholds rather than hard-coded statuses.
- Add a manual alias table for artist names and labels.
- Detect likely duplicate editions and expose them for review.
- Add negative decisions so rejected candidates are not repeatedly suggested.
- Support user overrides mapping one Bandcamp item to one TIDAL album.
- Add regression fixtures from real-world difficult cases, with identifying information minimized where possible.

### Acceptance criteria

- A match record explains why it was classified as high confidence.
- Re-running unchanged inputs uses the cache instead of repeating all catalogue searches.
- User overrides survive future scans.
- Threshold changes can be evaluated without re-fetching provider data.

## M3 — Review interface

**Goal:** Make the 61 `needs_review` and 83 `low_confidence` records easy to process.

**Status:** Ready for acceptance. The filtered CLI and keyboard review flow,
durable decisions and metadata edits, portable export/import, localhost review
desk, protected mutation API, candidate details/artwork, and dry-run pending
queue are implemented. Review actions persist only to SQLite and perform zero
provider writes.

### CLI review

- Add `sync review list` with filters by status, score, artist, label, and date.
- Add `sync review show <id>` with Bandcamp data, TIDAL candidates, scores, and explanations.
- Add interactive actions:
  - approve candidate;
  - reject candidate;
  - choose another candidate;
  - defer;
  - mark unavailable;
  - edit metadata.
- Add keyboard navigation and clear confirmation prompts.
- Export and import review decisions as a portable JSON file.

### Local web UI

- Build a small local-only web application.
- Display Bandcamp artwork/link, candidate TIDAL artwork/link, artist/title, edition, score, and evidence.
- Provide approve/reject/defer actions.
- Include a pending-write queue and a dry-run plan.
- Show a diff between the current TIDAL library and the proposed additions.
- Use localhost binding by default; require an explicit option for LAN exposure.
- Add CSRF protection, session protection, and no credential exposure to the browser.
- Make the UI optional so the CLI remains fully functional.

### Acceptance criteria

- A user can review a candidate without opening raw JSON.
- Approval creates a durable decision but does not write to TIDAL automatically unless the user separately applies the plan.
- The interface works with an empty database and with imported existing output files.

## M4 — Safe write orchestration

**Status:** Ready for acceptance. Immutable SQLite-backed plans, explicit
`--apply` gating, stable batch idempotency, pre-batch live-library checks,
durable request/response audits, stop-on-unknown outcomes, post-apply
verification, and configured maximum-addition limits are implemented. No live
provider write has been performed during development.

**Goal:** Make writes robust, transparent, and difficult to trigger accidentally.

The safety boundary starts in M0. M4 completes the durable plan/apply and
verification workflow; it must not be the first milestone that introduces
confirmation, dry-run, idempotency, or credential redaction.

### Tasks

- Implement a plan/apply separation:
  - `sync plan` creates an immutable proposed action set;
  - `sync apply <plan-id>` performs only that plan.
- Require explicit confirmation showing provider, collection, count, and a sample/list of targets.
- Add an optional `--yes` mode only for non-interactive environments and require a clearly documented safety flag.
- Use stable idempotency keys derived from plan and batch content, or persist generated keys before sending.
- Persist request payloads, response status, response body hashes, retries, and timestamps.
- Re-check the live library before every batch.
- Skip IDs already present in the current collection.
- Stop on ambiguous or unknown write outcomes rather than continuing blindly.
- Add a verification phase after every plan.
- Add a maximum-additions safety limit per run.
- Add a “dry-run always” configuration option for new installations.
- Never implement removal synchronization by default.

### Acceptance criteria

- A failed run can be resumed without duplicating successful work.
- A plan can be inspected before it is applied.
- Every applied album can be traced back to a source item, match decision, plan, batch, and provider response.

## M5 — Modern CLI and configuration experience

**Status:** Complete. The complete canonical command surface, interactive and
headless setup, validated commented JSONC configuration, structured/plain/
quiet/verbose output modes, progress UI, safe OAuth guidance and recovery,
browser fallback, shell completions, offline fixture tutorial, and an
acceptance runbook are implemented. Acceptance was completed on 2026-09-14:
the automated gate passed (`58 pass`, `0 fail`), offline init/tutorial/config
checks passed, and read-only checks against `output/m2-real.sqlite` reported
609 wishlist items, 290 matches, 180 review items, 261 already saved, 29
approved pending writes, 2 library snapshots, and completed run logs. No
provider writes were performed.

**Goal:** Make setup feel polished and approachable for technical users.

Do not begin the local web UI until the CLI contracts, persistent state, review
decisions, and plan/apply semantics are stable. The CLI remains the canonical
automation surface.

### CLI design

Suggested command surface:

```text
sync init
sync config show
sync config set <key> <value>
sync doctor
sync auth tidal
sync auth status
sync import bandcamp
sync scan [--incremental|--full]
sync matches list
sync review list
sync review show <id>
sync review approve <id>
sync plan create
sync plan show <plan-id>
sync apply <plan-id>
sync verify <plan-id>
sync status
sync logs <run-id>
sync export report
sync cache clear
sync self-update
```

### Setup experience

- Use a modern terminal framework with colored output, spinners, tables, progress bars, and accessible non-color output.
- Provide interactive setup and non-interactive flags for CI/headless use.
- Validate every configuration value immediately.
- Generate a safe local config file with comments and defaults.
- Explain OAuth scopes in plain language before authorization.
- Open the browser automatically when appropriate, with a copyable fallback URL.
- Provide recovery instructions for callback failures, expired tokens, and scope mismatches.
- Add shell completions for zsh, bash, fish, and PowerShell.
- Add `--json` output for scripts and automation.
- Add `--no-color`, `--quiet`, and `--verbose` modes.
- Add a first-run tutorial using fixture data.

### Suggested configuration

```yaml
version: 1
storage:
  database: ~/.config/bandcamp-tidal-sync/data.sqlite
  output_dir: ~/.config/bandcamp-tidal-sync/output
providers:
  bandcamp:
    wishlist_source: browser-export
  tidal:
    country_code: DE
    locale: en-US
    collection: me
matching:
  high_confidence_threshold: 0.90
  review_threshold: 0.70
  cache_ttl_days: 30
sync:
  batch_size: 25
  max_additions_per_run: 250
  delay_between_batches_ms: 2000
  require_confirmation: true
  verify_after_apply: true
security:
  bind_host: 127.0.0.1
  dry_run_by_default: true
```

Do not put access tokens or client secrets in this YAML. Use the OS keychain, an encrypted local secret file, or environment variables.

## M6 — Public release foundation

**Status:** Complete. Public project documentation, security and
privacy guidance, support matrix, migration guide, package metadata, Docker
review-image definition, issue templates, and CI/release runbooks are present.
The repository history has been rewritten to remove personal `output/` data.
GitHub Support ticket `#4759477` removed internal references for PR #1–#5 and
confirmed that the sensitive data was cleared from cache; the old commit hashes
are no longer accessible. Public visibility, private vulnerability reporting,
secret scanning, push protection, Dependabot security updates, and the
`Protect main` ruleset are enabled. Signed patch release `v0.1.1` corrected the
two packaging defects exposed by `v0.1.0` acceptance. Its tag, checksum, SLSA
provenance, macOS installation, and clean Linux-container installation were
verified; the packaged `--help`, `doctor`, and offline tutorial all passed with
zero provider writes.

**Goal:** Make the project understandable, secure, and installable by other users.

### Repository essentials

- Choose and add an open-source license.
- Write a concise README with screenshots or terminal recordings.
- Document supported platforms and prerequisites.
- Add a quick start that takes a new user from install to dry run.
- Add an architecture document.
- Add a threat model and security policy.
- Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and issue templates.
- Add a changelog and release process.
- Add a privacy statement explaining local data and provider communication.
- Add a support matrix for Bun/Node and operating systems.
- Add a public example configuration with placeholders only.
- Add a credential-handling guide.
- Add a migration guide from the current script-based project.

### Packaging

- Publish an npm package and/or standalone binaries.
- Offer Bun and Node installation paths if both are supported.
- Consider a single executable build for macOS, Linux, and Windows.
- Add Docker support for the optional web UI and scheduled operation.
- Publish signed release artifacts and checksums.
- Add shell completion files to releases.

### CI/CD

- Run formatting, linting, type checking, unit tests, integration tests, and security checks.
- Test against provider fixtures and mocked HTTP responses.
- Test pagination, retries, 401 refresh, 429 handling, malformed responses, and partial writes.
- Run dependency audits and secret scanning.
- Verify that test logs never contain tokens.
- Build release artifacts on tagged versions.

## M7 — Optional local web application and scheduling

**Status:** M7.0 incremental refresh and the M7.1–M7.9 dashboard, guided CLI,
recovery, scheduling, webhook, packaging, and acceptance work are implemented
and verified on fixture/disposable data. M6 release acceptance is complete.
See the [M7 design](m7-design.md) and [M7 verification runbook](m7-verification.md).

**Goal:** Make recurring use feel like an appliance while preserving self-hosting.

### Tasks

#### M7.0 — Incremental refresh

- Reuse cached match results for unchanged Bandcamp albums.
- Reuse the previous TIDAL library snapshot when the collection boundary is
  unchanged.
- Fall back to a full TIDAL traversal when a new album ID or collection-count
  change is detected, so additions and removals remain correct.
- Validated against a copied real-account database: one new Bandcamp album was
  detected and matched to TIDAL, with zero provider writes.

#### M7.x — Guided interactive CLI

The guided CLI is a separate M7 workstream layered over the existing canonical
commands. It is designed for recurring use without requiring users to
memorize multiple commands. See the [guided CLI design](m7-cli-design.md) and
[verification runbook](m7-cli-verification.md).

- Add `sync guided` with a status home screen and explicit refresh, review,
  plan, and exit choices.
- Show a precise refresh delta, including new/changed/removed wishlist items,
  new match outcomes, proposed additions, elapsed time, and provider writes.
- Keep refresh, review, and plan read-only; keep apply as a separate explicit
  safety boundary.
- Preserve direct commands, JSON automation, non-TTY determinism, and existing
  OAuth, SQLite, collection, and audit semantics.

- [x] Add a local dashboard with last run, pending review count, proposed additions, and failures.
- [x] Add a “Scan now” button.
- [x] Add a “Review matches” queue.
- [x] Add a “Create plan” button.
- [x] Add a separate, conspicuous “Apply approved plan” action.
- [x] Add scheduled scans with a visible next-run time.
- [x] Add opt-in webhook notifications with redacted summaries.
- [x] Add an activity log and downloadable reports.
- [x] Add health/readiness endpoints for container deployments.
- [x] Add backup/export and validated restore of the local database.
- [x] Add `sync guided` with TTY/non-TTY safety and direct-command parity.
- [x] Package dashboard assets and run fixture, mocked-apply, Docker, and browser acceptance.

### Security requirements

- Localhost-only by default.
- No public deployment without documented reverse-proxy and authentication guidance.
- Never expose provider tokens to client-side JavaScript.
- Use secure session cookies and CSRF protection.
- Provide a logout/revoke-token action.
- Make remote access an advanced configuration with explicit warnings.

## M8 — Provider extension foundation

**Status:** Implemented. This milestone prepares the codebase for Spotify,
Apple Music, and other services without implementing those integrations.

**Goal:** Make a second music provider an understandable, testable addition to
the project while keeping the current Bandcamp → TIDAL workflow stable.

### Scope

1. Define a small provider contract for catalogue search, album identity,
   artwork/link metadata, collection reads, collection writes, authorization
   status, and capability reporting.
2. Separate provider-neutral matching, review decisions, immutable plans,
   audit records, and verification from provider HTTP details.
3. Move the current TIDAL behavior behind the contract without changing the
   user-facing workflow or write safety rules.
4. Keep Bandcamp as a source adapter with a clear boundary from destination
   providers. A future provider may be a source, destination, or both only if
   it implements the relevant capabilities.
5. Define provider identifiers, capability versions, configuration namespaces,
   and migration rules for stored plans and snapshots.
6. Document a sanitized fixture and contract-test format that contributors can
   use without real accounts or credentials.
7. Add a contribution guide explaining how to propose a provider, what API
   access is required, how terms and rate limits are checked, and how secrets
   stay local.
8. Update the public roadmap and decision log to describe the extension point.

### Explicit non-goals

- No Spotify integration.
- No Apple Music integration.
- No new OAuth flows for future providers.
- No plugin marketplace or dynamic code loading.
- No provider-specific UI branches beyond capability-aware labels and links.
- No telemetry or anonymous diagnostics. Those require a separate, explicit
  privacy decision.

### Acceptance criteria

- A provider adapter contract is documented with request/response examples
  using sanitized fixtures.
- TIDAL passes the contract tests for search, collection read, collection
  write, authorization status, pagination, retryable errors, and unknown
  outcomes.
- Core matching, review, plan, apply, and audit tests run without importing
  TIDAL-specific HTTP code.
- An unsupported capability produces a clear user-facing message and cannot
  reach a write endpoint.
- Existing TIDAL plans, snapshots, and audit records remain readable after the
  adapter split.
- The full M7 verification gate and a fixture-only provider contract suite pass
  with zero real provider writes.

### Deliverables

- Provider contract and compatibility note.
- TIDAL adapter conformance tests and sanitized fixtures.
- Contributor guide for adding a provider.
- Migration note for provider IDs and stored snapshots.
- Updated architecture diagram and roadmap.

## M9 — Cross-platform installation and first-run foundation

**Status:** Implemented. Cross-platform clean-install coverage, local launcher,
and migration/rollback guidance are available.

**Goal:** Let a new user install and start the local service on macOS,
Windows, and Linux with the same documented path.

### Scope

- Choose and document the supported installation channels: release archive,
  package-manager path where practical, and Docker.
- Provide platform-specific launch commands that open or print the local web
  address.
- Detect Bun/runtime, port, filesystem, Docker, and permission problems before
  the UI starts.
- Use one predictable data directory and explain where the database, token
  files, backups, and logs live on each operating system.
- Make upgrades and rollback recoverable, including database migrations and
  release compatibility checks.
- Exercise clean installs in CI or disposable machines for all three platforms
  where hosted runners permit it.

### Acceptance criteria

- A fresh user can install, start, and stop the service using one documented
  path for each supported platform.
- The launcher reports an actionable error for missing runtime, occupied port,
  unwritable data directory, invalid config, or unavailable Docker.
- Existing local data survives an upgrade and a documented rollback restores
  the previous release.
- Package smoke tests verify that the installed artifact contains everything
  needed for the web UI and CLI.

## M10 — Web onboarding and account setup

**Status:** Planned. This is the first milestone aimed primarily at new users.

**Goal:** Replace command-line-only first-run configuration with a short,
guided local web setup.

### Scope

1. Welcome screen: explain local-only operation, where data is stored, and the
   read/write safety model.
2. Bandcamp step: enter the public wishlist username or URL, validate it, and
   show the resolved public source before saving.
3. TIDAL step: start OAuth in the browser, request read/write scopes with plain
   language, show success/expiry/scope status, and provide reauthorization.
4. Storage step: show the data directory, database path, backup behavior, and
   an optional change before initialization.
5. First sync step: explain that a large TIDAL library may take time, display
   live progress, and allow safe cancellation.
6. Completion screen: show wishlist count, library count, match categories,
   pending review count, and the next recommended action.
7. Re-entry: reopening the app must detect completed setup and take the user to
   the dashboard; expired authorization must route to reauthorization without
   losing local decisions.

### Acceptance criteria

- A new user can complete setup without opening a terminal after launching the
  service.
- Invalid Bandcamp input, cancelled OAuth, missing scopes, and expired tokens
  each produce a specific recovery action.
- Setup never sends a TIDAL write request.
- Refresh can be cancelled and resumed without corrupting the database.
- The UI explains token expiry and shows the exact reauthorization action.
- A fixture onboarding run is deterministic and a mocked-provider run covers
  success, 401, timeout, and cancellation.

## M11 — Observable sync and progress experience

**Status:** Planned. This milestone turns long-running work into an operation
the user can understand and trust.

**Goal:** Make scans feel alive, resumable, and honest about what is happening.

### Scope

- Show phases: loading wishlist, checking cache, searching catalogue, reading
  the collection, matching, saving state, and finishing.
- Show elapsed time, current phase, items processed/total when known, rate,
  retry count, and the last meaningful activity.
- Distinguish slow work from a stalled or failed operation.
- Surface 401 reauthorization, rate limits, network failures, and partial
  completion with a clear next action.
- Persist operation checkpoints and resume from the last safe boundary.
- Keep all scan/review/plan operations read-only; show provider write count
  explicitly in every completion summary.
- Provide a compact activity history with filters for scan, review, plan, apply,
  and authorization events.

### Acceptance criteria

- A large-library sync visibly changes progress at least once per meaningful
  phase and never appears frozen without an explanation.
- A refresh interrupted during a read resumes safely and does not duplicate
  provider work.
- A token expiry pauses with a reauthorization action and preserves progress.
- Completion shows exact counts for wishlist items, removed items, matches,
  needs review, low confidence, already saved, proposed additions, and provider
  writes.
- Browser acceptance covers narrow screens, refresh, cancellation, retry, and
  failure recovery.

## M12 — Simple review dashboard and first-run product polish

**Status:** Planned. This milestone consolidates the product experience after
the installation and onboarding foundations exist.

**Goal:** Make the core result understandable at a glance for a non-technical
user.

### Scope

- Use plain labels and short explanations for high-confidence, needs review,
  low-confidence, unavailable, deferred, already saved, and ready to add.
- Present Bandcamp and the selected provider candidate side by side, including
  artwork, title, artist, score, explanation, and external links.
- Make the safe path visually obvious: review → approve locally → inspect exact
  additions → explicitly apply.
- Put token state, last refresh, next action, and unresolved failures near the
  top of the dashboard.
- Provide empty states, loading states, retry states, and success summaries
  that tell the user what to do next.
- Add accessible keyboard navigation, screen-reader labels, contrast checks,
  and responsive layouts for laptop and small screens.
- Keep advanced technical details available behind expandable sections rather
  than in the primary flow.

### Acceptance criteria

- A first-time user can explain what the counts mean and identify the next
  action without reading project documentation.
- A user can distinguish a likely match from a candidate requiring review using
  title, artist, artwork, score, and explanation.
- No screen suggests that approval alone changes a provider collection.
- The full flow works at desktop and narrow mobile widths without clipped
  controls or ambiguous states.
- Usability acceptance is performed with a short scripted walkthrough and a
  small set of real read-only data.

## M13 — Additional provider integrations (separate projects)

**Status:** Future. Each provider is its own milestone after M8 and after the
onboarding/capability model is stable.

**Goal:** Add destinations such as Spotify or Apple Music without weakening the
shared safety model.

### Rules for each provider

- Confirm that the provider supports the required collection API and allowed
  use case before implementation.
- Implement the M8 adapter contract and capability checks first.
- Add sanitized fixtures, contract tests, OAuth diagnostics, rate-limit
  handling, and read-only scan acceptance before enabling writes.
- Reuse the same review, immutable plan, explicit confirmation, idempotency,
  audit, and verification flow.
- Release each provider behind an explicit configuration choice and document
  its scopes, limitations, and data handling.

The first provider candidate should be selected only after a short feasibility
spike confirms API access, collection semantics, artwork links, rate limits,
and terms of service. Provider selection is deliberately not part of M8.

# Technical architecture

```text
CLI / Local Web UI
        │
Application services
  scan · match · review · plan · apply · verify
        │
Core domain model and policy engine
        │
Provider adapters ── Bandcamp import
                  └─ TIDAL OAuth/catalogue/collection
        │
Storage layer ── SQLite database
              └─ encrypted/local secrets
        │
Audit/reporting layer
```

## Core domain entities

- `SourceItem`: a Bandcamp wishlist record.
- `Candidate`: a possible TIDAL album match.
- `MatchDecision`: score, evidence, status, and user decision.
- `LibrarySnapshot`: a timestamped set of TIDAL album IDs.
- `SyncPlan`: immutable proposed changes.
- `WriteBatch`: an idempotent provider request.
- `Verification`: post-write comparison and result.
- `SyncRun`: lifecycle, logs, errors, and summary.

### Suggested state machine

```text
discovered
  → candidates_found
  → high_confidence | needs_review | low_confidence | search_miss

needs_review → approved | rejected | deferred | overridden
high_confidence → planned → applying → applied → verified
applying → retryable_failure | unknown_outcome | permanent_failure
```

## Security and privacy backlog

- Never commit `.env`, token files, SQLite databases, or output containing private metadata.
- Add a strong `.gitignore` before publishing.
- Redact `Authorization`, refresh tokens, access tokens, cookies, and OAuth codes from logs.
- Use least-privilege scopes and explain why `collection.write` is required.
- Store tokens in the OS keychain where available.
- Provide a `sync auth revoke` command.
- Protect local database and output permissions on Unix systems.
- Avoid collecting analytics by default.
- Document which provider APIs receive which metadata.
- Add dependency and supply-chain controls.
- Add a security contact and responsible disclosure policy.

## Testing backlog

### Unit tests

- Unicode and title normalization.
- Artist alias resolution.
- Edition/remix detection.
- Match scoring and threshold boundaries.
- Pagination link parsing.
- CSV/JSON serialization.
- Plan immutability.
- Idempotency-key generation.

### Contract tests

- TIDAL OAuth token response.
- TIDAL collection-resource response.
- TIDAL relationship pagination.
- TIDAL collection write response.
- Error payloads and empty-body success responses.

### Failure tests

- 401 followed by refresh.
- 429 with and without `Retry-After`.
- 5xx retries.
- Network timeout.
- Process interruption between request and checkpoint.
- Malformed or stale manifest.
- Library changing between batches.
- Duplicate IDs.
- Scope missing.

### End-to-end tests

- Fixture Bandcamp wishlist → candidate matching → review → plan → mocked apply → verification.
- Repeat the same run and assert zero new writes.
- Resume after a failed batch.

## Release sequence

### v0.1 — Reliable local CLI

- Refactored provider adapters.
- SQLite state.
- OAuth and doctor command.
- Incremental scan.
- Dry-run plan.
- Manual apply with confirmation.
- Basic tests and documentation.

### v0.2 — Reviewable sync

- Interactive CLI review.
- Persistent overrides and rejections.
- Cache and incremental matching.
- Verification reports.
- Improved terminal UX.

### v0.3 — Local web UI

- Review queue.
- Plan/apply flow.
- Dashboard.
- Local scheduling.
- Backup/export.

### v1.0 — Public self-hosted release

- Cross-platform packaging.
- Security review and threat model.
- CI release pipeline.
- Migration tooling.
- Stable provider interface.
- Public documentation and contribution workflow.

### v1.1 — Friendly self-hosted product

- Cross-platform installation and upgrade path.
- Web-based first-run onboarding.
- Visible long-running sync progress and recovery.
- Simple review dashboard with clear counts and next actions.

### v1.2+ — Additional providers

- One provider per milestone after an API feasibility review.
- Spotify, Apple Music, or another service only when its collection API,
  authorization model, terms, and write semantics satisfy the shared provider
  contract.

## Immediate next sprint

M7 is complete. The next sprint should finish the small M8 foundation, then
move directly into the web-first product milestones:

1. M8: define the provider contract, split the TIDAL adapter boundary, add
   conformance tests, and publish the contributor/fixture documentation.
2. M9: make installation and upgrades predictable on macOS, Windows, Linux,
   and Docker.
3. M10: build the web onboarding wizard for Bandcamp source setup, TIDAL OAuth,
   storage, and the first read-only sync.
4. M11: add visible phases, progress, cancellation, reauthorization, and
   resumable recovery for long-running syncs.
5. M12: polish the review dashboard around simple counts, artwork, decisions,
   and the explicit apply boundary.
6. Only after those milestones, run a short feasibility spike for the first
   additional provider and schedule it as M13.

The CLI will receive maintenance and compatibility fixes during this sequence;
new workflow investment stays in the web interface.

## Definition of done for recurring use

A user should be able to:

1. Install the tool.
2. Run an interactive setup wizard.
3. Authenticate TIDAL with read/write scopes explained clearly.
4. Import or configure their Bandcamp wishlist.
5. Run an incremental scan later with one command.
6. Review uncertain matches in the terminal.
7. Generate a plan showing exact additions.
8. Apply only an explicitly approved plan.
9. Resume safely after interruption.
10. Verify that every intended album is present.
11. Inspect history and export a report.
12. Run the same process periodically without duplicate additions.

## Non-goals for the first public release

- Automatic deletion from TIDAL when an item leaves Bandcamp.
- Sharing or centralizing user credentials.
- Hosted multi-tenant operation.
- Silent background writes.
- Automatic approval of ambiguous matches.
- Provider scraping that violates terms or bypasses authentication controls.
- Analytics or telemetry without explicit opt-in.

## Decision log

- **Write only high-confidence matches automatically:** preserves trust and avoids silent false positives.
- **Review uncertain matches later:** keeps the first recurring workflow useful without blocking it.
- **Use immutable plans:** separates decision-making from external side effects.
- **Keep the CLI canonical:** supports automation, headless environments, and a stable foundation for the web UI.
- **Prefer local/self-hosted storage:** minimizes privacy exposure and makes the project portable.
- **Do not synchronize deletions:** deletion is destructive and has different user expectations from additions.
- **Known M3 UI bug (fixed):** the authored `.workspace` display rule overrode
  the browser's `[hidden]` rule, so selecting `Pending additions` left the review
  queue visible. The CSS now explicitly hides both views when their `hidden`
  attribute is set, and the M3 runbook includes a tab-switch check.
