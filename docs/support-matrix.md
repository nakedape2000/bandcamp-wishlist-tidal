# Support Matrix

| Component | Supported | Notes |
| --- | --- | --- |
| Bun | 1.3.x and newer 1.x | Primary runtime and test target |
| Node.js | Not yet supported as a runtime | The code uses Bun APIs; Node support requires a dedicated compatibility milestone |
| macOS | Apple Silicon and Intel, current supported releases | Primary development platform |
| Linux | Current Bun-supported x64/arm64 distributions | Local filesystem and browser required for OAuth |
| Windows | Not yet acceptance-tested | Shell completions exist, but release support is deferred |
| TIDAL API | OAuth collection and catalogue endpoints used by this version | Provider behavior can change without notice |
| Bandcamp | Public wishlist web/API behavior used by this version | Private wishlists are unsupported |
