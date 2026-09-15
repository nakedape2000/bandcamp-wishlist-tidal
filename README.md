# Bandcamp Wishlist to TIDAL

[![CI](https://github.com/nakedape2000/bandcamp-wishlist-tidal/actions/workflows/ci.yml/badge.svg)](https://github.com/nakedape2000/bandcamp-wishlist-tidal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Export a **public** Bandcamp wishlist to a single, easy-to-parse JSON file.

A zero-dependency [Bun](https://bun.sh) + TypeScript CLI. It reads the wishlist
the same way Bandcamp's own web UI does: it fetches the public profile page once
to resolve the account's `fan_id`, then pages through Bandcamp's `wishlist_items`
API until the whole list is collected. No login, no credentials — it only works
with wishlists that are public (the Bandcamp default).

## Modern sync CLI

The unified entry point is safe to use offline while setting up a local
installation:

```sh
bun run sync -- init
bun run sync -- tutorial
bun run sync -- config show
bun run sync -- config set sync.batch_size 10
bun run sync -- status --json
```

`init` refuses to overwrite an existing configuration unless `--force` is
provided. Configuration files are written with restrictive permissions, and
`security.dry_run_by_default` cannot be disabled through `config set`.
Use `--json` for automation or `--quiet` to suppress human-readable output.
Use `--no-color` for accessible/plain terminal output and `--verbose` when
diagnosing a scan. `init --interactive` prompts for local paths and TIDAL
region; `init --bandcamp-user NAME --database PATH --output-dir PATH --country DE --locale en-US`
provides the equivalent headless setup. The generated JSONC includes safety
comments and defaults but never credentials.

The canonical command surface is:

```text
sync init | config | doctor | auth | import | scan | matches | review
sync plan | apply | verify | status | logs | export | cache | completions
sync tutorial | self-update
```

Generate completion scripts with `bun run sync -- completions zsh` (or
`bash`, `fish`, `powershell`).

After setup, `bun run sync -- scan` is the canonical read-only refresh. It
updates the public Bandcamp wishlist, current TIDAL library snapshot, catalogue
matches, and SQLite state. Use `--verbose` for request details and `--json` for
a single machine-readable summary. It never adds or removes TIDAL albums.

### TIDAL authorization recovery

`bun run sync -- auth tidal` explains the requested read/write collection
scopes, opens the browser when possible, and always prints a fallback URL. It
does not add albums. If the callback port is busy, close the process using it
or configure another registered localhost `TIDAL_REDIRECT_URI`. If the token
is expired or lacks a required scope, `bun run sync -- auth status` and
`bun run sync -- doctor` report that condition; rerun `auth tidal` to replace
the local token.

## Requirements

- [Bun](https://bun.sh) 1.x

## Install

```bash
git clone https://github.com/nakedape2000/bandcamp-wishlist-tidal.git
cd bandcamp-wishlist-tidal
bun install
```

## Usage

```bash
bun run src/cli.ts --user <username> [options]
```

| Flag       | Default                  | Description                                             |
| ---------- | ------------------------ | ------------------------------------------------------- |
| `--user`   | (required)               | Bandcamp username (the `bandcamp.com/<username>` part). |
| `--out`    | `./output/wishlist.json` | Output file path. Parent dirs are created.              |
| `--pretty` | off                      | Pretty-print the JSON (2-space indent).                 |
| `--count`  | `100`                    | Items fetched per API request.                          |
| `--help`   |                          | Show usage.                                             |

Example:

```bash
bun run src/cli.ts --user jzstern --pretty
# Resolving fan id for "jzstern"…
# Fetching wishlist (fan_id 1238758)…
#   1347 items…
# Wrote 1347 items → ./output/wishlist.json
```

## Output shape

```jsonc
{
  "source": "bandcamp",
  "schema_version": 1,
  "username": "jzstern",
  "fanId": 1238758,
  "fetchedAt": "2026-07-17T21:00:00.000Z",
  "count": 1347,
  "items": [
    {
      "itemId": 2405228465,
      "itemType": "album",          // "album" | "track"
      "artist": "Sub Basics & Pugilist",
      "title": "Control",
      "url": "https://pugilist.bandcamp.com/album/control",
      "artUrl": "https://f4.bcbits.com/img/a2643044056_9.jpg",
      "addedAt": "2026-07-17T07:21:17.000Z"  // ISO 8601, or null
    }
  ]
}
```

## Development

```bash
bun test          # unit tests for the pure parsing layer
bunx tsc --noEmit # typecheck
bun run check     # Biome lint + format
```

The planned evolution from the current scripts to a recurring Bandcamp → TIDAL
sync tool is documented in [`docs/future-development-backlog.md`](docs/future-development-backlog.md).

## Project documentation

- [Architecture](docs/architecture.md)
- [Privacy](docs/privacy.md)
- [Threat model](docs/threat-model.md)
- [Credential handling](docs/credentials.md)
- [Migration from legacy scripts](docs/migration.md)
- [Support matrix](docs/support-matrix.md)
- [Release process](docs/release-process.md)
- [M7 dashboard design](docs/m7-design.md)
- [M7 verification runbook](docs/m7-verification.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

The package exposes the `bandcamp-tidal-sync` executable for Bun-based installs.
Use the repository quick start above until a tagged package release is
published. Node.js is not currently a supported runtime; see the support matrix.

`src/parse.ts` holds the pure, unit-tested parsing functions (tested against real
captured fixtures in `test/fixtures/`). All network I/O is isolated in
`src/bandcamp.ts`, so if Bandcamp's internal API ever changes, there's a single
place to fix.

## Real-account verification

The end-to-end workflow can be tested safely against a real public Bandcamp
wishlist and a real TIDAL account. The steps below do not write anything to
TIDAL; `--apply` is intentionally not used.

```bash
# 1. Export the Bandcamp wishlist into this repository's output directory.
bun run export -- --user <bandcamp-username> --pretty

# 2. Authenticate TIDAL once (requires TIDAL_CLIENT_ID in .env).
bun run tidal:auth
# Open the printed URL, approve access, and wait for the localhost callback.

# 3. Confirm the token and local environment.
bun run doctor

# 4. Export the current TIDAL library (read-only).
bun run tidal:export-library

# 5. Search TIDAL and create match records (read-only; can take time).
BCTS_DATABASE=./output/m2-real.sqlite bun run tidal:scan

# 6. Build the comparison report and inspect the proposed additions.
bun run tidal-compare-library.ts

# 7. Persist the wishlist, matches, and library snapshot into SQLite.
BCTS_DATABASE=./output/m2-real.sqlite bun run sync

# 8. Rebuild write manifests from the fresh comparison.
bun run tidal:plan-additions

# 9. Validate the fresh write plans without making provider changes.
bun run tidal:add-pilot
bun run tidal:add-remaining
```

Expected safety signals: `doctor` reports all checks as `PASS`; the scan writes
`output/tidal-matches.json`; the comparison report separates already-saved and
to-save albums; the planning command reports `Provider writes: 0`; and both add
commands print `Dry run only`. A real TIDAL write
requires an explicit, separately reviewed `--apply` invocation.

## Review interface

Review uncertain matches in the terminal without opening raw JSON:

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review browse
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review list --status needs_review
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review show <bandcamp-item-id>
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review pending
```

Or start the optional local review desk:

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run review:web
```

Open `http://127.0.0.1:4173`. The server binds to localhost unless `--host` is
provided explicitly. Approve, reject, defer, edit, and unavailable actions only
save local SQLite decisions. The pending-additions view is a dry-run diff and
cannot write to TIDAL. TIDAL artwork is read from public album-page metadata;
account credentials are never sent to the browser.

Portable decisions can be exported and restored with:

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review export
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- review import ./output/review-decisions.v1.json
```

## Plan and apply

After reviewing and approving local matches, create an immutable write plan:

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- plan --out ./output/tidal-write-plan.json
```

Inspect the printed `plan_id` and the JSON file. Applying a plan without the
explicit safety flag is still a dry run:

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- apply <plan-id>
```

Only a separately reviewed plan can reach the provider, and it requires both
`--apply` and an interactive confirmation (or `--yes` for an already reviewed
non-interactive job):

```bash
BCTS_DATABASE=./output/m2-real.sqlite bun run sync -- apply <plan-id> --apply
```

Before every batch the current TIDAL library is fetched again. Requests and
responses are audited in SQLite, successful batches are skipped on resume, and
the plan is not marked complete unless a post-apply library check finds every
requested album. No removal operation exists.

## Notes

- The wishlist API is Bandcamp's own undocumented internal endpoint; it can change
  without notice. Parsing failures surface a clear error rather than writing a
  partial file.
- A wishlist set to private returns no items — make it public to export it.
- Be a good citizen: the tool paces its requests (~4/sec) and fetches only what
  the public web UI already serves.

## Disclaimer

Not affiliated with or endorsed by Bandcamp. This tool reads only the public data
Bandcamp's own web UI already serves, via an undocumented internal endpoint that may
change or break at any time. Use it for your own wishlists and be considerate of
Bandcamp's servers — review their [Terms of Use](https://bandcamp.com/terms_of_use)
and use at your own risk.

## Contributing

Issues and pull requests welcome. Please run `bun test`, `bunx tsc --noEmit`, and
`bun run check` before opening a PR.

## License

[MIT](LICENSE)
