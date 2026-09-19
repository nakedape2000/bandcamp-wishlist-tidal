# Support Matrix

| Component | Supported | Notes |
| --- | --- | --- |
| Bun | 1.3.x and newer 1.x | Primary runtime and test target |
| Node.js | Not yet supported as a runtime | The code uses Bun APIs; Node support requires a dedicated compatibility milestone |
| macOS | Apple Silicon and Intel, current supported releases | Release archive and Docker clean-install smoke coverage |
| Linux | Current Bun-supported x64/arm64 distributions | Release archive and Docker; local filesystem and browser required for OAuth |
| Windows | Current Bun-supported releases | Release archive clean-install smoke coverage; use PowerShell commands |
| TIDAL API | OAuth collection and catalogue endpoints used by this version | Provider behavior can change without notice |
| Bandcamp | Public wishlist web/API behavior used by this version | Private wishlists are unsupported |
