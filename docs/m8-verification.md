# M8 Verification

M8 is a code and fixture-only milestone. It must not be verified against a real
Bandcamp or TIDAL account.

```sh
bun run verify:m8
```

Expected result: all tests pass, type checking and Biome pass, and the command
ends without opening a browser, reading a real token, contacting a provider, or
adding music to a collection.

The contract suite specifically verifies TIDAL's normalized catalogue search,
pagination, collection reads, idempotent collection write payload, unconfigured
authorization status, retryable HTTP behavior, unknown write outcome, and the
capability guard. The existing M7 gate verifies that dashboard and workflow
behavior remains intact.
