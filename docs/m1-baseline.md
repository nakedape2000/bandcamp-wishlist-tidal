# M-1 Baseline

This document records the starting point for the Bandcamp → TIDAL refactor.

## Current Inventory

- The supported production entry point is the Bun/TypeScript Bandcamp exporter.
- Bandcamp parsing and normalization are covered by 11 unit tests and two captured fixtures.
- TIDAL integration is currently a collection of standalone scripts for OAuth, search, matching, library export, comparison, and writes.
- Current local snapshot: 606 wishlist items, 468 match records, 835 TIDAL library albums, 256 high-confidence matches, 190 albums pending save in the recorded workflow, and 190 successful additions.
- Personal credentials and current TIDAL token data are local-only and ignored by Git. They must not be used by CI or committed as fixtures.

## M-1 Deliverables

- Versioned JSON Schemas for a wishlist snapshot and the fixture dry-run plan.
- An offline fixture dry run that performs parsing and normalization only and reports zero provider writes.
- A reproducible verification checklist in `docs/m1-verification.md`.
- The roadmap updated with M-1 gates and environment requirements.

## Baseline Policy

The real output directory is an audit trail for one local account, not a public test oracle. Future tests should use minimized fixtures and assert invariants, not personal counts. Any migration of existing output must preserve the raw source file and record the schema version of the imported representation.
