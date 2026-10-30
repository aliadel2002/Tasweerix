## 2023-10-26 - [Defense in Depth Enhancement: Path Canonicalization Bypass]
**Vulnerability:** Path traversal check in `resolveAsset` (`packages/media/src/node/handler.ts`) stripped leading slashes *before* decoding the URI component. This allowed encoded slashes (like `%2f`) to bypass the absolute path prevention logic.
**Learning:** Always decode inputs *before* applying path canonicalization or sanitization to ensure you're validating the actual final data, preventing attackers from obfuscating malicious payloads through URL encoding.
**Prevention:** Perform all necessary decoding steps first in input validation pipelines before applying boundary checks or sanitization.
