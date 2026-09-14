# M1 Verification Runbook

Run these checks after M1 implementation and before starting M2.

## 1. Install deterministically

```bash
bun --version
bun install --frozen-lockfile
```

Expected: Bun 1.x is reported and dependency installation completes without changing `bun.lock`.

## 2. Run the unit suite

```bash
bun test
```

Expected: all tests pass, including the M1 sync-store tests.

## 3. Verify incremental sync state

```bash
bun run verify:m1
```

Expected: the first run reports discovered items and `writes: 0`; the second reports `discovered: 0`, `changed: 0`, and `writes: 0`.

When the existing TIDAL artifacts are present, the summary also reports `already_saved`, `approved_pending_write`, `written`, `failed`, `needs_review`, and `not_found` separately. These counters are informational; this command never performs provider writes.

The sync database stores stable Bandcamp IDs, source fingerprints, first/last seen timestamps, removed markers, sync runs, and resumable write batches. Removing an item marks it as removed and never deletes it from the database or TIDAL.

When the write command is explicitly run with `--apply`, each batch is also recorded in the configured SQLite database (`BCTS_DATABASE` may override its path), alongside the legacy JSON audit. Failed runs are marked `failed`; successful batches are marked complete and are skipped on resume.

For a live Bandcamp refresh, set `BCTS_USERNAME` and run `bun run scan:bandcamp`, then run `bun run sync`. The scan writes a versioned local snapshot; it does not call TIDAL and does not perform writes.

## 8. Optional schedule

```bash
BCTS_SCHEDULE_MINUTES=360 bun run schedule:print
```

Expected: a launchd plist is printed with the repository as its working directory and no automatic installation. Review the plist, save it under `~/Library/LaunchAgents/`, and load it manually only after confirming the environment variables and credentials are available to launchd.

## 4. Type-check the project

```bash
TMPDIR=/private/tmp BUN_INSTALL_CACHE_DIR=/private/tmp/bun-install-cache bunx --bun tsc --noEmit
```

Expected: exit code 0 and no diagnostics. On a normal local shell the explicit temporary-directory variables may be omitted; they are useful in Codex's sandboxed terminal.

## 5. Run the offline workflow

```bash
bun run dry-run:fixture > /tmp/bandcamp-fixture-plan.json
```

Expected: valid JSON with `mode: "fixture-dry-run"`, `item_count: 5`, and `provider_writes: 0`. The command must complete with no network access and no TIDAL credentials.

## 6. Check deterministic output

```bash
bun run dry-run:fixture > /tmp/plan-a.json
bun run dry-run:fixture > /tmp/plan-b.json
cmp /tmp/plan-a.json /tmp/plan-b.json
```

Expected: `cmp` reports no differences.

## 7. Check repository hygiene

```bash
git status --short
git diff --check
git check-ignore .env output/tidal-tokens.json
```

Expected: no whitespace errors; `.env` and `output/tidal-tokens.json` are ignored; credentials are not required for any check above.

## 9. Optional live checks

Only after all offline checks pass, run provider connectivity or OAuth checks. These are not M-1 acceptance tests and must never be required by CI.
