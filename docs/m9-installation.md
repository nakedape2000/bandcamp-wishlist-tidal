# Install and Start

M9 supports Bun 1.x on macOS, Linux, and Windows. The app is local-first: its
database, exports, token, backups, and logs stay on the computer where it runs.

## Recommended: release archive

Download the `.tgz` asset from a GitHub release into an empty folder, then
install it with Bun. This does not require cloning the repository.

### macOS and Linux

```sh
mkdir bcts
cd bcts
bun init -y
bun add /path/to/bandcamp-tidal-sync-<version>.tgz
./node_modules/.bin/bandcamp-tidal-sync start --open
```

### Windows PowerShell

```powershell
mkdir bcts
cd bcts
bun init -y
bun add C:\path\to\bandcamp-tidal-sync-<version>.tgz
.\node_modules\.bin\bandcamp-tidal-sync start --open
```

`start` checks the local configuration, data directory, and dashboard port
before it starts the browser interface. Use `start --check` for diagnostics
only, or `start --port 4174 --open` when port 4173 is already in use. Stop the
service with `Ctrl+C` in the terminal that started it.

## Docker

Docker is an alternative for users who already have Docker Desktop or Docker
Engine with the Compose plugin. It runs from a source checkout, which includes
`docker-compose.yml`:

```sh
docker compose config
docker compose up --build
```

Open `http://127.0.0.1:4173`; stop it with `Ctrl+C`, or run
`docker compose down` in another terminal. To diagnose Docker availability
without starting a container, run:

```sh
bandcamp-tidal-sync start --check --docker
```

The Compose port is intentionally loopback-only. It stores application data in
`./data` by default. Set `BCTS_DATA_DIR` to an absolute host path before
starting Compose to place that directory elsewhere. Do not commit this folder.

## Local data

New installations use one directory:

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/bandcamp-tidal-sync` |
| Linux | `$XDG_STATE_HOME/bandcamp-tidal-sync`, or `~/.local/state/bandcamp-tidal-sync` |
| Windows | `%APPDATA%\bandcamp-tidal-sync` |
| Docker | `./data` on the host, mounted at `/data` |

The directory contains `config.json`, `data.sqlite`, `output/` (including the
TIDAL token and backups), and local JSON/CSV reports. Set `BCTS_DATA_DIR` to
choose a different directory. `BCTS_CONFIG` and `BCTS_DATABASE` remain precise
overrides for advanced use.

Existing installations with a project-local `./config.json` keep using that
file and its existing database. M9 never moves or deletes it automatically.

## Upgrade and rollback

Before upgrading, create a local backup:

```sh
bandcamp-tidal-sync backup create
```

Stop the running dashboard. Install the next release archive in the same Bun
project, then run `bandcamp-tidal-sync start --check`. The release reads the
existing config and SQLite database in place. If it does not work, stop it,
reinstall the previous archive, and start it again. To restore data as well,
use the backup command with a new target first:

```sh
bandcamp-tidal-sync backup restore <backup.sqlite> --database <new-data.sqlite>
```

Only use `--replace` after verifying both paths. Backup and restore never write
to a music provider.

## Troubleshooting

| Diagnostic | Meaning and action |
| --- | --- |
| `Bun runtime` warning | Install Bun 1.x and run the command again. |
| `Configuration or data directory` warning | Check the shown config path and choose a writable `BCTS_DATA_DIR`. |
| `Dashboard port` warning | Stop the process on the shown port or start with another `--port`. |
| `Docker Compose` warning | Install/start Docker Desktop or use the Bun installation path. |

Authentication is not required to open the dashboard. A TIDAL token is created
only when the user chooses to authorize TIDAL; it can expire and be renewed
later with `bandcamp-tidal-sync auth tidal`.
