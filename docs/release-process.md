# Release Process

1. Update the version and `CHANGELOG.md`.
2. Run the complete command sequence in `docs/m6-verification.md`, including
   tests, type checking, the release-scoped Biome check, and package inspection.
3. Build and inspect release artifacts in a clean checkout. Install the archive
   in a temporary directory with `bun run package:smoke -- <archive.tgz>` so
   `--help`, `doctor`, and the offline tutorial are tested as shipped.
4. Create a signed git tag. The release workflow runs tests, builds the npm
   archive, generates SHA-256 checksums, and attaches GitHub build provenance.
5. Review the generated archive and npm publish dry run, then publish the
   package or binaries only from the tagged commit.
6. Verify the published archive in a fresh temporary directory using the quick
   start and fixture tutorial. Never run a release verification with
   `--apply`.

The CI workflow, Dependabot alerts, secret scan, and OSV dependency audit are
required pre-release gates. GitHub Dependency Review is unavailable, so
`Dependency audit / osv-scan` scans `bun.lock` for every pull request and `main`
update, on a weekly schedule, and again before the release workflow packages an
archive. The release workflow also repeats the tests and secret scan on the
tagged commit before packaging, attestation, or publication.
Publishing credentials must be stored in the hosting provider's secret store,
never in repository files. The workflow intentionally creates a release archive
but does not run `npm publish`; publication is a maintainer-controlled action.
Dependabot keeps package and GitHub Action dependencies current through reviewed
pull requests. `CODEOWNERS` requires maintainer review for security, provider,
Docker, and release changes.
