# Privacy

This tool is local-first. It stores configuration, OAuth tokens, wishlist
snapshots, match decisions, and audit records on the machine where it runs.

Bandcamp requests read the public wishlist data needed for the configured
account. TIDAL requests use the OAuth scopes shown during authorization to read
the library and catalogue and, only after an explicit apply, add approved
albums. The tool does not sell, upload, or share local data with a separate
analytics service and has no telemetry or background cloud service.

The optional web UI is localhost-only by default. It reads local state through
the local server; provider tokens are never placed in client-side JavaScript.
Users are responsible for securing their operating-system account, backups,
logs, exported reports, and any reverse proxy used for remote access.
