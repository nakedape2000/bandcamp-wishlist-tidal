# M6 Verification Runbook

Run these checks from a clean checkout. They do not contact Bandcamp or TIDAL
and they never write to a provider collection.

```sh
bun install --frozen-lockfile
bun test
TMPDIR=/private/tmp BUN_INSTALL_CACHE_DIR=/private/tmp/bun-install-cache bunx --bun tsc --noEmit
bunx biome check docs/example-config.jsonc scripts/main.ts package.json
git diff --check -- . ':!output/**'
bun run release:check
bun pm pack --dry-run
npm publish --dry-run --ignore-scripts
```

Expected results:

- Tests pass, type checking exits successfully, and the scoped Biome check is
  clean.
- The package dry run lists the CLI, docs, schemas, and source but no `.env`,
  SQLite database, or `output/` data.
- The npm publish dry run completes without authentication and shows the same
  sanitized payload.
- Dependency auditing is a release prerequisite. Dependabot alerts and update
  pull requests are enabled for this repository. GitHub's `dependency-review`
  action is intentionally not a required check because the repository's GitHub
  integration reports it as unsupported even with Dependency Graph enabled;
  enable that integration or add an OSV scanner before a public release.
- CI runs repository secret scanning with Gitleaks. A finding blocks the
  release and must be removed or rotated before publication.
- README links resolve to architecture, privacy, security, credential,
  migration, support, contributing, and release documentation.

For a local container smoke test, build the image and start it with
`docker compose up --build`. Confirm the review UI is reachable only through
`127.0.0.1:4173`; the container listens on its internal interface while
Compose keeps the host port bound to localhost. Stop the container after the
check. The opt-in scheduler can
be started with `docker compose --profile scheduler up scheduler`; it runs the
read-only scan loop and must use a private volume/config. Do not mount a token
file into a public or shared container.

M6 remains ready for acceptance until a tagged release is built, checksummed,
and published through the documented release process. Publishing and signing
require maintainer credentials and are intentionally not performed by this
repository-local verification.
