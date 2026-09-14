# M2 Verification Runbook

Run from the repository root.

```bash
bun run verify:m2
```

Expected: all tests pass, typecheck exits 0, and there are no whitespace errors.

The matching tests cover Unicode/punctuation and edition normalization, explainable confidence scoring, aliases, configurable thresholds, not-found explanations, duplicate editions, regression fixtures, and TTL cache expiry. SQLite state tests cover durable overrides and negative decisions.

For a live catalogue scan, run `bun run tidal-scan.ts` with a valid token and `BCTS_DATABASE` pointing at the configured state database. Re-running an unchanged search uses the persisted TTL cache. This runbook never invokes `--apply`.
