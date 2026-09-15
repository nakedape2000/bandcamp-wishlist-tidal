# Architecture

Bandcamp to TIDAL Sync is a local-first TypeScript application. The CLI is
the canonical interface; the optional review desk is a localhost client of the
same application services.

## Runtime flow

1. The Bandcamp adapter reads the public wishlist export/API and produces a
   normalized wishlist snapshot.
2. The TIDAL adapter authenticates through OAuth, reads the user's library,
   and searches the catalogue. It does not write during a scan.
3. Provider-neutral matching normalizes artist/title metadata, scores
   candidates, and records an explainable decision.
4. The SQLite state store persists snapshots, decisions, plans, batches, and
   provider responses so interrupted work can resume safely.
5. Review and planning services turn approved decisions into immutable plans.
6. The write orchestrator rechecks the live TIDAL library before each batch,
   performs idempotent additions, and verifies the final library.

## Boundaries and invariants

- Provider credentials remain on the local machine and are never sent to the
  browser UI.
- Scans and plans are read-only with respect to TIDAL. Writes require an
  explicit `--apply` plus confirmation.
- No removal synchronization is implemented.
- SQLite is the source of truth for durable decisions and audit history;
  JSON/CSV files are exports and diagnostics.
- The review server binds to localhost by default and uses CSRF-protected,
  session-authenticated decision endpoints.

## Extension points

Provider-specific HTTP and OAuth behavior lives in adapters. Matching,
reconciliation, review, planning, and orchestration are provider-neutral. A
future provider should implement read/search/write capabilities behind the
same service contracts without changing review or plan semantics.
