# Migration From Script-Based Usage

The legacy scripts remain available while the modern `sync` CLI becomes the
canonical interface.

| Legacy workflow | Modern equivalent |
| --- | --- |
| `bun run export -- --user NAME` | `bun run sync -- import bandcamp` or `sync scan` |
| `bun run tidal:auth` | `bun run sync -- auth tidal` |
| `bun run tidal:export-library` | `bun run sync -- scan` |
| `bun run tidal:scan` | `bun run sync -- scan` |
| `bun run tidal-compare-library.ts` | `bun run sync -- matches list` / `sync status` |
| `bun run tidal:add-pilot` and `tidal:add-remaining` | `sync plan create`, then `sync apply <plan-id>` |

Existing JSON/CSV exports can be imported into a new SQLite database with the
import command. Keep the old output directory until the new database has been
verified. The modern workflow is dry-run by default and does not delete old
records or remove albums from TIDAL.

## M8 provider compatibility

M8 introduces an internal destination-provider contract but does not migrate
or rewrite existing databases. Existing plans with provider `tidal`, legacy
TIDAL library snapshots, and write audit records continue to be read through
the TIDAL adapter. No Spotify, Apple Music, or other account configuration is
added in this release. Future provider-specific storage must use stable
lower-case provider IDs, configuration under `providers.<provider-id>`, and an
explicit reversible migration. M8 provider contract version `1` is compatible
with all current records.

## M9 local data directory

New installations use the operating-system data directory documented in
[Install and Start](m9-installation.md). A pre-M9 project-local `./config.json`
is detected first and continues to use its existing SQLite database and output
directory. No automatic move occurs. Back up before choosing a new
`BCTS_DATA_DIR`; rollback is performed by reinstalling the prior release and,
when needed, restoring a validated backup.
