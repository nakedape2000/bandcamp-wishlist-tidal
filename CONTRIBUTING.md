# Contributing

## Development setup

Install Bun 1.x, clone the repository, and run `bun install`. Run the full
verification set before opening a pull request:

```sh
bun run verify:m9
bun run release:check
```

Changes that affect provider behavior must include fixture or mocked HTTP
coverage. Never use real credentials or provider writes in tests.
Read [the provider contribution guide](docs/adding-a-provider.md) before adding
or proposing a destination service.

## Pull requests

Explain the user-visible behavior, safety implications, and test evidence.
Keep changes focused. Update the README, changelog, or docs when public
behavior changes. Review plans before any command that could write to TIDAL.
