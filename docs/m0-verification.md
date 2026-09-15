# M0 Verification Runbook

Run these checks from the repository root before declaring M0 complete.

## Automated checks

```bash
bun install --frozen-lockfile
bun test
bun run check:m0
TMPDIR=/private/tmp BUN_INSTALL_CACHE_DIR=/private/tmp/bun-install-cache bunx --bun tsc --noEmit
bun run doctor
bun run import:output
bun run dry-run:fixture > /tmp/m0-plan-a.json
bun run dry-run:fixture > /tmp/m0-plan-b.json
cmp /tmp/m0-plan-a.json /tmp/m0-plan-b.json
bun run tidal-add-pilot.ts
bun run tidal-add-remaining.ts
```

Expected: dependencies do not change `bun.lock`; all tests pass; typecheck exits with code 0; doctor reports no failed checks; import completes without network access; both write commands print `Dry run only` and make no TIDAL requests; and `cmp` reports no differences.

## Safety checks

```bash
bun -e 'const p=await Bun.file("/tmp/m0-plan-a.json").json(); if(p.provider_writes!==0) process.exit(1); console.log(p.item_count, p.provider_writes)'
git check-ignore .env output/tidal-tokens.json
# macOS
for f in .env output/tidal-tokens.json output/imported-state.v1.json output/tidal-add-pilot-result.json output/tidal-add-pilot-request.json output/tidal-add-remaining-results.json; do test -e "$f" && stat -f '%Sp %N' "$f"; done
# Linux
for f in .env output/tidal-tokens.json output/imported-state.v1.json output/tidal-add-pilot-result.json output/tidal-add-pilot-request.json output/tidal-add-remaining-results.json; do test -e "$f" && stat -c '%A %n' "$f"; done
git diff --check
```

Expected: the fixture plan reports five items and zero provider writes; all credential files are ignored; all local credential, audit, and imported-state files are `-rw-------`; and there are no whitespace errors.

`--apply` is intentionally absent from this runbook. It is the explicit safety boundary for live writes and requires a separately reviewed plan plus user confirmation.

## Provider smoke checks

Only after the offline checks pass, run OAuth or read-only TIDAL export with a local token. Do not run a write command as part of M0 verification. Any live write requires a separately reviewed plan and explicit user confirmation.
