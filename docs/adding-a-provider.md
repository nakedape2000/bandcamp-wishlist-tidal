# Adding a Music Provider

This guide is for a proposed future destination such as Spotify or Apple
Music. It does not authorize adding either integration today.

1. Open a design issue documenting the provider's permitted API use, user
   authorization model, collection semantics, rate limits, and whether albums
   can be added idempotently.
2. Confirm that the provider's terms allow the intended personal-library use.
   Do not scrape authenticated web pages when an approved API is required.
3. Implement `DestinationProvider` in `src/providers/<provider>-adapter.ts`.
   Keep OAuth, HTTP URLs, request payloads, pagination, and response parsing in
   that adapter.
4. Declare only genuinely supported capabilities. An unsupported write must
   fail through `requireCapability` before any request is made.
5. Require a non-empty idempotency key for every write. Preserve the existing
   plan, batch, audit, resume, live recheck, and verification safety model.
6. Add sanitized conformance fixtures and cover search, pagination,
   authorization state, collection read, write, retryable errors, and an
   ambiguous/unknown write result.
7. Add configuration under `providers.<provider-id>`, with no secret in the
   config file. Match contract version `1` unless an explicitly documented
   breaking contract migration has been approved. Tokens remain local,
   permission-restricted files and must never be served by the browser UI or
   committed.
8. Add a migration and user-facing compatibility note before storing provider
   IDs in new database fields.

A provider is accepted only after its fixture-only contract suite and the full
project verification gate pass with zero real provider writes.
