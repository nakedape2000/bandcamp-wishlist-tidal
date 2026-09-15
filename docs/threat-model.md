# Threat Model

## Assets

- TIDAL access and refresh tokens.
- Local SQLite state, wishlist exports, match decisions, and audit records.
- The ability to add albums to the user's TIDAL collection.

## Trust boundaries

- Bandcamp and TIDAL are external services.
- The CLI reads local configuration, environment variables, and token files.
- The optional review server accepts requests from the local browser.
- The filesystem and local user account are trusted relative to the app.

## Main threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Token disclosure | Token files are chmod `0600`; logs redact credential-shaped fields; browser receives no token | A compromised local account can read local secrets |
| Unauthorized TIDAL writes | Dry-run default, immutable plans, explicit `--apply`, confirmation, live-library recheck | A user can intentionally approve a bad plan |
| CSRF against review actions | SameSite session cookie plus CSRF token on state-changing routes | Local malware can act as the user |
| Cross-site requests to localhost | Server binds to `127.0.0.1`; origin and session checks | Browser extensions or local processes remain in scope |
| Provider/API tampering | HTTPS requests, schema validation, response hashing in audit records | A malicious provider response can still produce a bad match; review is required |
| Denial of service | Pagination limits, retry policy, request pacing, bounded batch sizes | Provider outages and rate limits |
| Data loss during writes | Durable batch state, idempotency keys, resume behavior, post-apply verification | Filesystem or database corruption |

## Security assumptions

The machine and user account running the tool are trusted. The review UI is
not designed for public hosting. Remote access requires a separately secured
reverse proxy, authentication layer, and network policy.
