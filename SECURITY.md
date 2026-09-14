# Security Policy

## Supported versions

Security fixes are currently provided for the latest version on the default
branch. This project is pre-1.0 and does not promise long-term support for old
releases.

## Reporting a vulnerability

Do not open a public issue for a suspected credential leak, authentication
bypass, or unauthorized provider write. Send a private report to the
maintainer through the repository hosting provider's private security
reporting channel, including reproduction steps, affected version, and impact.

Until a private channel is configured, keep the report local and contact the
repository owner directly rather than publishing exploit details.

## Safe use

Run the review server on localhost only, keep token/config files private, and
inspect an immutable plan before every apply. Never paste token files or
unredacted logs into issues.
