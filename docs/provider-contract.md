# Provider Contract

M8 defines a small, compile-time provider boundary. It is not a plugin system,
does not load third-party code, and does not grant any network access by itself.
The current contract version is `1`.

## Roles

- A source adapter returns normalized Bandcamp-style wishlist records. Bandcamp
  is currently the only source and is implemented in `src/bandcamp.ts`.
- A destination adapter implements `DestinationProvider` from
  `src/provider-contract.ts`. TIDAL is the only current destination.

The core matching, review, plan, audit, and write-safety layers only use
normalized album IDs and metadata. Provider adapters own HTTP paths, OAuth
details, pagination documents, and provider-specific write payloads.

## Destination capabilities

| Capability | Contract method | Meaning |
| --- | --- | --- |
| `catalogue-search` | `searchAlbums(query)` | Return normalized album candidates. |
| `collection-read` | `readCollectionAlbumIds(collection)` | Read every album ID in a collection. |
| `collection-write` | `addAlbums(collection, ids, key)` | Add albums using a non-empty idempotency key. |
| `authorization-status` | `authorizationStatus()` | Report configured, expiry, missing scopes, and safe guidance. |

`verifyCollectionAlbumIds` is a read-only consistency check used after an
explicit write. `requireCapability` must run before an adapter operation. If a
capability is absent it throws `ProviderCapabilityError`, whose message states
that no provider request was made.

## Normalized data

`ProviderAlbum` uses a provider-local string `id`, title, artists, public URL,
and optional artwork, release date, and track count. No token, raw response, or
provider request object crosses the adapter boundary.

`ProviderWriteResult` retains only the HTTP status and response body needed for
the durable local audit record. A network exception is intentionally not
reclassified as success: callers record it as an unknown outcome and stop.

## Sanitized fixture format

Contract fixtures live under `test/fixtures/providers/<provider>/`. They may
contain made-up IDs, catalogue metadata, pagination links, empty write
responses, and representative error status codes. They must not contain real
account IDs, usernames, tokens, cookie values, authorization headers, or
captured private library data. `test/m8.test.ts` is the TIDAL conformance
example and makes no network request or provider write.

## Compatibility

Provider IDs are stable lower-case strings. Existing records use `tidal` and
continue to resolve to the TIDAL adapter. Existing SQLite tables keep their
current names and payload format in M8; in particular,
`tidal_library_snapshots` and `write_plan_items.tidal_album_id` remain readable
legacy storage. A future data migration may introduce provider-neutral table
names only with an explicit, reversible migration.

Every provider publishes the same contract version. A breaking method or
normalized-data change increments that version and requires a compatibility
note plus a migration before release. Provider configuration belongs only under
the matching JSON namespace, for example `providers.bandcamp` and
`providers.tidal`; credentials never belong in configuration.
