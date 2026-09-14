# Credential Handling

1. Create a TIDAL developer client and register a localhost redirect URI.
2. Keep `TIDAL_CLIENT_ID` and `TIDAL_REDIRECT_URI` in the process environment or
   a local `.env` file excluded by `.gitignore`.
3. Run `sync auth tidal`. The OAuth token is stored in the configured local
   token file with mode `0600`.
4. Use `sync auth status` or `sync doctor` to inspect expiry and scopes. These
   commands never print token values.
5. Back up tokens only through an encrypted OS backup. Do not commit them,
   paste them into bug reports, or expose them to the web UI.

To revoke access, remove the local token file and revoke the application from
the TIDAL account settings. A future release will add a first-class revoke
command.
