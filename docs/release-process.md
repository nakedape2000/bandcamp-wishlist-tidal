# Release Process

1. Update the version and `CHANGELOG.md`.
2. Run `bun run verify:m5`, `bunx tsc --noEmit`, and `bun run check`.
3. Build and inspect release artifacts in a clean checkout.
4. Create a signed git tag. The release workflow runs tests, builds the npm
   archive, generates SHA-256 checksums, and attaches GitHub build provenance.
5. Review the generated archive and npm publish dry run, then publish the
   package or binaries only from the tagged commit.
6. Verify the published archive in a fresh temporary directory using the quick
   start and fixture tutorial. Never run a release verification with
   `--apply`.

The CI and dependency-review workflows are required pre-release gates.
Publishing credentials must be stored in the hosting provider's secret store,
never in repository files. The workflow intentionally creates a release archive
but does not run `npm publish`; publication is a maintainer-controlled action.
Dependabot keeps package and GitHub Action dependencies current through reviewed
pull requests. `CODEOWNERS` requires maintainer review for security, provider,
Docker, and release changes.
