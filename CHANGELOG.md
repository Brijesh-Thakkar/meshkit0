# Changelog

## Unreleased

### Added

- **`createHeliaClient(helia, { offline? })`** — a `MeshkitClient` backed by an in-process Helia node (no Kubo daemon). Exported from both the Node and browser entries (tested on Node only). Targets **Helia 7** (`helia@^7`, `@helia/unixfs@^8`, `@helia/ipns@^10`), which uses the same `multiformats@^14` as Meshkit — no version pin or dedupe workaround is needed. Requires the optional peer dependencies `helia`, `@helia/unixfs`, `@helia/ipns`, `@libp2p/crypto` and `@libp2p/peer-id`; they are imported lazily, so Kubo/S3-only users are unaffected.
  - `countPins` counts pinned roots only (a multi-block upload is one pin); `indirect` is always `0`.
  - `list` returns every pinned root as `{ cid, size, uploadedAt }`, like the S3 client. `uploadedAt` is recorded in pin metadata when `pin()` runs; roots pinned elsewhere report the Unix epoch.
  - Helia 7 does not start itself and creates libp2p on `start()`: call `await helia.start()` before IPNS/key calls (other calls and `healthCheck` work on any node). `healthCheck` checks `helia.status`.
  - `resolveName` returns the newest record from `@helia/ipns` 10's async-iterable `resolve`.
  - `generateKey` generates an Ed25519 (or RSA) key and imports it into the libp2p keychain (`helia.libp2p.services.keychain`). IPNS names are the key's PeerID (`12D3Koo…`), not the keychain's `KeyInfo.id`.
  - `resolveName` looks the name up as a keychain label and resolves with its public key; otherwise it treats the input as an IPNS name.
  - `retrieve`, `pin` and `publishName` accept a CID object from the caller's own `multiformats@14` as well as a string.
  - `offline: true` skips the DHT for IPNS and disables network block fetches.
- `encrypt`, `decrypt`, `isEncryptedPayload`, `DEFAULT_ITERATIONS` and the `EncryptOptions` type are now also exported from the **browser** entry (`index.browser`). They were already exported from the Node entry.
- `npm run test:dist` builds and runs `tests/dist`, which imports the built ESM and CJS bundles and checks the crypto exports and `createHeliaClient`.

### Not supported / skipped

- Online IPNS publish through Helia (the DHT / delegated routers) is not covered by tests: it needs internet access and took ~44s against the public network. Offline publish/resolve is tested.

## 1.2.1 — 2026-07-28

### Added

- **Client-side encrypted storage** — both the Kubo and S3 backends now support transparent AES-256-GCM encryption. Data is encrypted locally before it leaves the device; the IPFS network and storage provider only ever see the ciphertext.

  **How it works — upload path:**
  1. Caller passes `{ encrypt: { password, iterations? } }` to `upload()`.
  2. A fresh 128-bit random salt and a fresh 96-bit random nonce are generated using `globalThis.crypto.getRandomValues` (CSPRNG — works on Node.js ≥ 20, browsers, and React Native).
  3. A 256-bit AES key is derived from the password + salt using **PBKDF2-SHA256** with the configured iteration count (default: 200,000 — the OWASP 2023 minimum). Because salt and iteration count are random/configurable per call, the same password + plaintext always produces a different key.
  4. The plaintext is encrypted with **AES-256-GCM**. GCM appends a 128-bit authentication tag that covers both the ciphertext and the associated header fields, so any bit-level tampering is detected at decryption time.
  5. The output is assembled as an **EMSH** (Encrypted MeSHkit) blob with a self-describing 37-byte header:

     ```
     ┌────────┬─────────┬────────────┬──────────┬──────────┬──────────────────────┐
     │ MAGIC  │ VERSION │ ITERATIONS │  SALT    │  NONCE   │  CIPHERTEXT + TAG    │
     │ 4 B    │ 1 B     │ 4 B uint32 │ 16 B     │ 12 B     │  n + 16 B            │
     │ "EMSH" │ 0x01    │ big-endian │ random   │ random   │  AES-256-GCM output  │
     └────────┴─────────┴────────────┴──────────┴──────────┴──────────────────────┘
     ```

  6. The EMSH blob is uploaded to IPFS (or the S3 bucket). Because salt and nonce are randomised per call, uploading the same plaintext twice yields two different CIDs — content is not linkable across uploads.

  **How it works — retrieve path:**
  1. Caller passes `{ password }` to `retrieve()`.
  2. The raw bytes are fetched from IPFS / S3 by CID.
  3. `isEncryptedPayload()` checks the 4-byte EMSH magic prefix and the version byte. If they match, decryption proceeds; otherwise the raw bytes are returned as-is (plain-content round-trips are unaffected).
  4. The iteration count, salt, and nonce are read directly from the EMSH header — no out-of-band metadata is needed.
  5. The AES-256 key is re-derived from the password + header salt + header iteration count via PBKDF2-SHA256.
  6. AES-256-GCM decryption verifies the GCM authentication tag. Any wrong password or any ciphertext / header corruption causes decryption to throw a generic `MeshkitError` (`"Decryption failed: wrong password or corrupted data"`) — wrong-password and tampered-payload errors are intentionally indistinguishable to prevent oracle attacks.
  7. The original plaintext bytes are returned to the caller.

- **New exports:**
  - `encrypt(data, { password, iterations? }): Promise<Uint8Array>` — standalone encrypt; returns an EMSH payload
  - `decrypt(data, password): Promise<Uint8Array>` — standalone decrypt; throws `MeshkitError` on wrong password or tampering
  - `isEncryptedPayload(data): boolean` — structural check (magic + version bytes only; never touches the password)
  - `DEFAULT_ITERATIONS` — `200_000`; re-exported constant for callers who want to reference the default explicitly
  - `EncryptOptions` — TypeScript type: `{ password: string; iterations?: number }`

- **Encryption on `upload()` / `retrieve()`** — both `MeshkitClient` implementations (`createMeshkitClient` for Kubo and `createS3Client` / `createFilOneClient` for S3) now accept:
  - `upload(data, { encrypt: { password, iterations? } })` — encrypts before upload
  - `retrieve(cid, { password })` — decrypts after fetch; omitting `password` returns the raw EMSH bytes

- **MCP server encryption tools** (`@ipfs-meshkit/mcp`) — `ipfs_upload` now accepts optional `password` and `pbkdf2Iterations` parameters; `ipfs_retrieve` now accepts optional `password`. AI agents can store and retrieve encrypted content without the plaintext ever reaching the IPFS network.

- **Crypto dependencies** — `@noble/ciphers@2.2.0` (AES-256-GCM) and `@noble/hashes@2.2.0` (PBKDF2-SHA256 + SHA-256) added as runtime dependencies. Both are from the `@noble` suite and covered by the published [Cure53 security audit](https://cure53.de/pentest-report_noble-crypto.pdf).

### Security

- Resolved **7 CVEs** across transitive dependencies (0 remaining):
  - `brace-expansion` ≤5.0.7 — DoS via unbounded expansion (HIGH, CVSS 7.5) — fixed by upgrading `vitest` + `@vitest/coverage-v8` to v4
  - `brace-expansion` ≥2.0.0 <2.1.2 — DoS via exponential expansion (HIGH, CVSS 5.3) — bumped to 2.1.2
  - `fast-uri` 3.0.0–3.1.3 — host confusion via backslash (HIGH, CVSS 7.5) — bumped to 3.1.4
  - `postcss` ≤8.5.17 — path traversal in source map loading (HIGH, CVSS 7.5) — bumped to 8.5.23
  - `shell-quote` ≤1.8.4 — quadratic-complexity DoS (HIGH, CVSS 7.5) — bumped to 1.10.0
  - `@hono/node-server` <2.0.5 — path traversal via encoded backslash (MODERATE, CVSS 5.9) — bumped to 2.0.12
  - `esbuild` 0.27.3–0.28.0 — arbitrary file read via dev server (LOW, CVSS 2.5) — resolved via `overrides`
- Added **iteration count guards** to `crypto.ts`:
  - `encrypt()` now rejects `iterations < 1_000` — catches accidental typos that would produce dangerously weak key derivation
  - `decrypt()` now rejects payloads whose header declares `iterations > 10_000_000` — prevents a crafted EMSH blob from hanging a server with a multi-hour PBKDF2 run

### Changed

- `@vitest/coverage-v8` and `vitest` upgraded from v3 to v4.1.10
- `zod` upgraded from 3.x to 4.4.3 in `@ipfs-meshkit/mcp` (`@modelcontextprotocol/sdk` supports `^3.25 || ^4.0`)
- `@types/node` upgraded from `^25` to `^26.1.2` across all packages
- `multiformats` floor bumped to `^14.0.5`
- `@modelcontextprotocol/sdk` floor bumped to `^1.30.0`
- `@ipfs-meshkit/meshkit` dependency in `@ipfs-meshkit/mcp` changed from pinned registry version `1.0.2` to workspace `^1.2.0`

### Fixed

- Integration test phase 1 passed `localNode: true, ...localNodeOptions` to `init()` which caused the daemon to start on the default port 5001 instead of the test port 15005; changed to `localNode: localNodeOptions` (object form) so the port is correctly forwarded to `startIPFSNode()`

## 1.2.0 — 2026-07-22

### Added

- **`createS3Client(config)`** — universal `MeshkitClient` backed by any S3-compatible object store (fil.one, Lighthouse, Filebase, 4EVERLAND, etc.)
  - `config.endpoint` is now required and explicit — point it at any S3-compatible service
  - All upload/retrieve/pin/healthCheck logic is unchanged from the previous `createFilOneClient` implementation
  - **`listPins()`** — now works on S3 clients: issues a real `ListObjectsV2` XML request, handles pagination via `ContinuationToken`, filters out non-CID keys (any key containing `.` is excluded)
  - **`list()`** — new method; returns `StoredObject[]` with `{ cid, size, uploadedAt }` for every object in the bucket (same pagination and filtering as `listPins()`)
- **`StoredObject`** interface — `{ cid: string; size: number; uploadedAt: string }` (ISO 8601); exported from the package root
- **`S3StorageConfig`** interface — `{ accessKeyId, secretAccessKey, bucket, endpoint }`; exported from the package root
- **`list(): Promise<StoredObject[]>`** added to the `MeshkitClient` and `Meshkit` interfaces
  - Throws `MeshkitError` on Kubo clients (`createMeshkitClient`, `Meshkit` class) — use `listPins()` on the Kubo path instead
- **Browser / Capacitor build** — a separate `dist/index.browser.{js,cjs,d.ts}` entry is now built and wired to the `browser` export condition in `package.json`; Vite, Capacitor, and React Native bundlers resolve this automatically and no longer encounter `child_process` / `path` errors

### Changed

- **`createFilOneClient`** is now a thin preset over `createS3Client` — it passes through all config and defaults `endpoint` to `https://eu-west-1.s3.fil.one`. The exported `FilOneConfig` type is unchanged and `endpoint` remains optional. No breaking change.
- **`listPins()` on S3 clients** previously threw `MeshkitError`; it now returns real data. If you were catching that error to detect S3 backends, use `list()` as the feature-detection check instead.

### Notes

- `createS3Client` and `createFilOneClient` both implement the same `MeshkitClient` interface — they are drop-in replacements for each other and for `createMeshkitClient` wherever a `MeshkitClient` is accepted
- Store the CID returned by `upload()` in your own database — there is no IPFS DHT lookup on the S3 path; the CID is the S3 object key and is only retrievable if you hold it

## 1.1.0 — 2026-07-22

### Added

- **`createFilOneClient(config)`** — new `MeshkitClient` backed by [fil.one](https://fil.one) (Filecoin-native S3-compatible object storage) instead of a Kubo daemon
  - CID is computed locally (CIDv1, raw codec, sha2-256) — no IPFS node required
  - Objects stored at `<endpoint>/<bucket>/<cid>` via AWS Signature V4 (`aws4fetch`)
  - `upload()` issues a signed PUT; `retrieve()` issues a signed GET
  - `pin()` is a silent no-op (object store has no pin layer, so callers don't need special-casing)
  - `healthCheck()` issues a signed HEAD on the bucket — validates credentials and bucket existence
  - IPNS operations (`publishName`, `resolveName`, `resolveAndRetrieve`, `generateKey`, `listKeys`, `listPins`) throw `MeshkitError` with a clear message explaining the limitation
- **`FilOneConfig`** interface exported from the root package — `accessKeyId`, `secretAccessKey`, `bucket`, optional `endpoint` (default: `https://eu-west-1.s3.fil.one`)
- `multiformats` added as a dependency for local CID computation

### Notes

- `createFilOneClient` is a drop-in `MeshkitClient` — works anywhere `createMeshkitClient` works, including Ionic/Capacitor, React Native, and browser environments (no daemon spawn required)
- Do not use `init()` or `startIPFSNode()` with fil.one — those are Node.js daemon paths; use `createFilOneClient` directly

## 1.0.2 — 2026-07-11

### Added

- `Meshkit.listPins()` and `MeshkitClient.listPins()` — list pinned CIDs on the primary node via `kubo-rpc-client` (respects RPC auth headers)

### Notes

- Publish `@ipfs-meshkit/meshkit@1.0.2` before `@ipfs-meshkit/mcp@1.0.0`; MCP depends on `meshkit.listPins()`.

## 1.0.1 — 2026-07-06

### Fixed

- README and package metadata: correct repository links to [IPFS-Meshkit/meshkit0](https://github.com/IPFS-Meshkit/meshkit0)
- Expanded README with install, usage examples, API overview, and CommonJS support

## 1.0.0 — 2026-06-18

### Added

- **`@ipfs-meshkit/meshkit` v1.0.0** — single npm package with root `dist/` (ESM + CJS + TypeScript)
- Bundles core, node, and meshkit into one install — `npm install @ipfs-meshkit/meshkit`
- Portable `./.ipfs` repo for server migration
- Unit test suite with coverage; integration tests for persistence, IPNS, attach (local, requires Kubo)

### Not included in 1.0.0

- Separate `@ipfs-meshkit/core` / `@ipfs-meshkit/node` npm packages (code is bundled into meshkit)
- `@ipfs-meshkit/react-native` and `@ipfs-meshkit/capacitor` remain private in the monorepo
