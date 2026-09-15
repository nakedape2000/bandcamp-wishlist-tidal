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
