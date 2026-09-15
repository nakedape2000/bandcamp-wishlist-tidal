# M4 Verification Runbook

This milestone contains the first workflow capable of writing to TIDAL. The
steps below deliberately stop before a live write unless you explicitly choose
to run the final `--apply` command.

## 1. Automated checks

```bash
bun run verify:m4
```

Expected: all tests, typecheck, formatting, and empty-database checks pass.

## 2. Build and inspect a plan

Use a disposable database containing your imported matches and local review
decisions:

```bash
cp ./output/m2-real.sqlite /tmp/bcts-m4-acceptance.sqlite
BCTS_DATABASE=/tmp/bcts-m4-acceptance.sqlite bun run sync -- plan --out /tmp/bcts-tidal-plan.json
```

Record the printed `plan_id`. Inspect `/tmp/bcts-tidal-plan.json` and confirm
the provider, collection, count, source item IDs, TIDAL IDs, and targets are
correct. Re-running with the same timestamp is not permitted to overwrite the
existing immutable plan.

## 3. Dry-run apply gate

```bash
BCTS_DATABASE=/tmp/bcts-m4-acceptance.sqlite bun run sync -- apply <plan-id>
```

Expected: it prints `Dry run only` and `provider writes: 0`. It must not read or
send a provider write request.

## 4. Live apply (optional, explicit)

Only after inspecting the plan and accepting the targets, run:

```bash
BCTS_DATABASE=/tmp/bcts-m4-acceptance.sqlite bun run sync -- apply <plan-id> --apply
```

The command re-reads the authenticated TIDAL library before every batch,
skips IDs already present, persists the request and idempotency key before
sending, records response status/body hash, and stops on an unknown outcome.
After the final batch it re-reads the library and refuses to mark the plan
complete if any requested album is missing.

Use `sync apply <plan-id> --apply --yes` only in a non-interactive environment
where the plan has already been independently reviewed. Never use `--yes`
without `--apply`.

## 5. Resume and audit

Inspect the plan database after an interrupted or completed run:

```bash
sqlite3 /tmp/bcts-m4-acceptance.sqlite \
  'select plan_id,status from write_plans;'
sqlite3 /tmp/bcts-m4-acceptance.sqlite \
  'select plan_id,batch_number,status,idempotency_key,response_status,response_body_hash from write_attempts;'
```

Successful batches are not sent again when the same plan is resumed. Failed or
unknown batches leave the plan non-complete and require an explicit operator
decision.

M4 is accepted when the automated checks pass, the dry-run gate is observed,
and any optional live run has a matching post-apply verification record.
