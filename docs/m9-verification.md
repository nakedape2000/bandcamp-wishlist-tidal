# M9 Verification

M9 verifies local installation and launch behavior without authorizing a music
provider or adding albums.

## Development gate

```sh
bun run verify:m9
bun pm pack --filename /tmp/bcts-m9.tgz
bun run package:smoke -- /tmp/bcts-m9.tgz
```

Expected: tests, type check, formatting, and package smoke pass. The installed
package runs its help, credential-free doctor, offline tutorial, and
`start --check` from a temporary data directory.

## Manual clean-install acceptance

Perform this once on each supported OS, following
[Install and Start](m9-installation.md). Use a new empty folder and a release
archive; do not use a real TIDAL token or `--apply`.

1. Install the archive with the platform command from the guide.
2. Run `bandcamp-tidal-sync start --check` and confirm all local checks pass.
3. Run `bandcamp-tidal-sync start --open`, confirm the dashboard opens at a
   loopback URL, then stop it with `Ctrl+C`.
4. Run `bandcamp-tidal-sync tutorial`; confirm it reports fixture dry-run and
   zero provider writes.
5. Create a backup, install a second archive version, run `start --check`, and
   confirm the prior config/database path remains in use. Reinstall the first
   archive to confirm rollback; restore a backup to a new target if needed.

For Docker, run `docker compose config`, then `docker compose up --build` and
confirm the dashboard opens at `http://127.0.0.1:4173`. Stop the container and
confirm `./data` remains. Do not expose the port on a LAN as part of M9.

## CI coverage

The CI workflow runs `verify:m9`, builds a package, and runs package smoke on
Ubuntu, macOS, and Windows. Docker remains a manual acceptance path because
hosted runners do not provide a consistent Docker Desktop environment.
