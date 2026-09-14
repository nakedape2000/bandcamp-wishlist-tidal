# M5 verification runbook

This first M5 slice verifies the modern CLI entry points without contacting either provider.

```sh
tmp_dir=$(mktemp -d)
bun run sync -- init --config "$tmp_dir/config.json" --bandcamp-user example --country DE --locale en-US
bun run sync -- tutorial --json
bun run sync -- config set sync.batch_size 10 --config "$tmp_dir/config.json" --json
bun run sync -- config show --config "$tmp_dir/config.json" --json
bun run sync -- status --config "$tmp_dir/config.json" --json
```

Expected results:

- `init` creates a versioned config with mode `0600` and `output/` beside it; the SQLite file is created by the first stateful command.
- The config contains JSONC safety comments and the complete version-one defaults.
- `tutorial` reports fixture data and `provider_writes: 0` without network access.
- A second `init` without `--force` refuses to overwrite the config.
- `config set` stores a typed numeric value and still enforces dry-run-by-default.
- `config show --json` emits machine-readable configuration only.
- `status --json` reports `initialized: false` before the first sync.

`init` also accepts `--bandcamp-user`, `--database`, `--output-dir`, `--country`, and `--locale`,
which makes it suitable for headless setup without editing JSON by hand.

Additional offline commands:

```sh
bun run sync -- auth status --json
bun run sync -- matches list --database "$tmp_dir/data.sqlite" --json
bun run sync -- logs --database "$tmp_dir/data.sqlite" --json
bun run sync -- completions zsh
bun run sync -- export report --config "$tmp_dir/config.json" --out "$tmp_dir/report.json" --json
bun run sync -- plan create --config "$tmp_dir/config.json" --json
```

These commands must not contact Bandcamp or TIDAL. `auth status` never prints
the token value; `matches` and `logs` return empty collections before the first
run; completions contain the supported top-level commands; and the report is a
versioned JSON artifact.

For a read-only check against the accepted real database:

```sh
bun run sync -- status --database ./output/m2-real.sqlite
bun run sync -- matches list --database ./output/m2-real.sqlite --json
bun run sync -- logs --database ./output/m2-real.sqlite --json
```

No acceptance command in this runbook contains `--apply`; provider writes must
remain zero. The live `sync scan` command is intentionally excluded because it
contacts both providers and can take significant time. It refreshes the
Bandcamp wishlist, current TIDAL library snapshot, catalogue matches, and
SQLite state in that order, while remaining read-only with respect to the
TIDAL collection.

Automated gate: `bun run verify:m5`.
