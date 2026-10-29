# IPFS Meshkit

**@ipfs-meshkit/meshkit** is a TypeScript SDK for decentralized storage with two backends and one unified interface:

- **Kubo / IPFS** — for Node.js and server apps that can run a daemon
- **S3-compatible object storage** (fil.one, Lighthouse, Filebase, 4EVERLAND, …) — for browsers, Ionic/Capacitor, and mobile apps where no daemon is possible

Both backends implement the same `MeshkitClient` interface (`upload`, `retrieve`, `pin`, `list`, `listPins`, …) so you can swap backends without changing application logic.

**Built-in client-side encryption** — any upload can be transparently encrypted with AES-256-GCM before it leaves the device. The IPFS network and the storage provider only ever see the ciphertext.

[![test](https://github.com/IPFS-Meshkit/meshkit0/actions/workflows/test.yml/badge.svg)](https://github.com/IPFS-Meshkit/meshkit0/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@ipfs-meshkit/meshkit.svg)](https://www.npmjs.com/package/@ipfs-meshkit/meshkit)
[![license](https://img.shields.io/npm/l/@ipfs-meshkit/meshkit.svg)](https://github.com/IPFS-Meshkit/meshkit0/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@ipfs-meshkit/meshkit.svg)](https://www.npmjs.com/package/@ipfs-meshkit/meshkit)

[![NPM](https://nodei.co/npm/@ipfs-meshkit/meshkit.png?downloads=true&downloadRank=true)](https://www.npmjs.com/package/@ipfs-meshkit/meshkit)

---

## Install

```bash
npm install @ipfs-meshkit/meshkit
```

**Requirements:** Node.js **20+**.
- **Kubo path** (`localNode: true`): install [Kubo](https://docs.ipfs.tech/install/) and ensure `ipfs` is on your `PATH`.
- **S3 path** (`createS3Client` / `createFilOneClient`): no daemon needed — works in browsers, Ionic/Capacitor, and React Native.

---

## How it works

```
Two backends, one MeshkitClient interface
─────────────────────────────────────────────────────────────────────

  Kubo / IPFS path (Node.js, server)
  ────────────────────────────────────────────────────────────────
  init()  →  Kubo RPC (:5001)  →  ./.ipfs on disk
               upload · retrieve · pin · IPNS · listPins · failover

  S3-compatible path (browser, Ionic, mobile — no daemon)
  ────────────────────────────────────────────────────────────────
  createS3Client()  →  fil.one / Lighthouse / Filebase / …
                          upload · retrieve · list · listPins
```

The S3 path computes a CID locally (CIDv1, raw codec, sha2-256) from the raw bytes and uses it as the S3 object key. **This CID is not published to the IPFS network** — it is a content-addressed key private to your bucket. Store the CID in your own database so you can retrieve the file later.

---

## Quick start — Kubo (Node.js)

```typescript
import { init, setupGracefulShutdown } from '@ipfs-meshkit/meshkit';

const { meshkit, localNode } = await init({ localNode: true });
setupGracefulShutdown(localNode);

const bytes = new TextEncoder().encode('hello world');
const cid = await meshkit.upload(bytes);
await meshkit.pin(cid);

const retrieved = await meshkit.retrieve(cid);
console.log(new TextDecoder().decode(retrieved)); // hello world
```

`localNode: true` starts or attaches to a Kubo daemon on `http://127.0.0.1:5001` and stores data in `./.ipfs`. Add `.ipfs` to `.gitignore`.

---

## Quick start — S3-compatible storage (browser / Ionic / mobile)

```typescript
import { createS3Client } from '@ipfs-meshkit/meshkit';

const client = createS3Client({
  accessKeyId: process.env.STORAGE_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET!,
  bucket: 'my-bucket',
  endpoint: 'https://<your-s3-compatible-endpoint>', // fil.one, Lighthouse, Filebase, 4EVERLAND, …
});

// Upload — CID is computed locally from the raw bytes
const bytes = new TextEncoder().encode('invoice payload');
const cid = await client.upload(bytes);
console.log('stored at key:', cid); // bafkrei...

// Retrieve — fetch back by the same CID
const retrieved = await client.retrieve(cid);

// List everything in the bucket
const objects = await client.list();
// → [{ cid: 'bafkrei...', size: 14, uploadedAt: '2026-07-22T10:00:00.000Z' }, ...]
```

> **Store your CIDs.** There is no directory listing backed by IPFS. `list()` queries the S3 bucket directly. If you lose the CID and the bucket is empty, there is no way to rediscover the file from the IPFS network.

---

## Quick start — Encrypted storage

Encryption works on **both backends** with a single option. The content is encrypted client-side before upload and decrypted client-side after retrieval — the IPFS network and storage provider never see the plaintext.

```typescript
import { init, isEncryptedPayload } from '@ipfs-meshkit/meshkit';

const { meshkit } = await init({ localNode: true });
const PASSWORD = 'correct-horse-battery-staple';

// Encrypt on upload
const data = new TextEncoder().encode('confidential manifest data');
const cid = await meshkit.upload(data, {
  encrypt: { password: PASSWORD },
});

// Retrieve + decrypt in one call
const plaintext = await meshkit.retrieve(cid, { password: PASSWORD });
console.log(new TextDecoder().decode(plaintext)); // confidential manifest data

// Retrieve without password — you get the raw encrypted blob
const raw = await meshkit.retrieve(cid);
console.log(isEncryptedPayload(raw)); // true

// Wrong password throws MeshkitError
await meshkit.retrieve(cid, { password: 'wrong' }); // throws
```

The S3 path works identically:

```typescript
import { createFilOneClient } from '@ipfs-meshkit/meshkit';

const client = createFilOneClient({ /* credentials */ });

const cid = await client.upload(data, {
  encrypt: { password: PASSWORD },
});
const plaintext = await client.retrieve(cid, { password: PASSWORD });
```

### How encryption works

**Upload path**

```
password + plaintext
        │
        ├── CSPRNG ──────────────────────► 128-bit salt  (fresh every call)
        │                                  96-bit nonce  (fresh every call)
        │
        ├── PBKDF2-SHA256(password, salt, iterations)
        │         └──────────────────────► 256-bit AES key
        │
        └── AES-256-GCM(key, nonce, plaintext)
                  └──────────────────────► ciphertext + 128-bit auth tag
                                                    │
                                          packed as EMSH blob
                                                    │
                                          upload to IPFS / S3  ──► CID
```

**Retrieve path**

```
CID ──► fetch raw bytes from IPFS / S3
              │
              ├── isEncryptedPayload()? ──► no  ──► return as-is
              │
              └── yes: read iterations, salt, nonce from EMSH header
                          │
                          ├── PBKDF2-SHA256(password, salt, iterations)
                          │         └──────────────────────► 256-bit AES key
                          │
                          └── AES-256-GCM decrypt + verify auth tag
                                    │
                                    ├── tag valid   ──► plaintext
                                    └── tag invalid ──► MeshkitError (wrong password or tampered)
```

**EMSH wire format** — every encrypted payload starts with a 37-byte self-describing header:

| Offset | Size | Field | Value |
|--------|------|-------|-------|
| 0 | 4 B | Magic | `EMSH` (`0x45 0x4D 0x53 0x48`) — identifies encrypted content |
| 4 | 1 B | Version | `0x01` |
| 5 | 4 B | Iterations | PBKDF2 iteration count, uint32 big-endian |
| 9 | 16 B | Salt | Random, unique per `encrypt()` call |
| 25 | 12 B | Nonce | Random, unique per `encrypt()` call |
| 37 | n + 16 B | Ciphertext + Tag | AES-256-GCM output; last 16 bytes are the authentication tag |

Because salt and nonce are random per call, uploading the same plaintext twice produces two different CIDs — content is not linkable across uploads.

**Algorithm properties**

| Property | Value |
|---|---|
| Cipher | AES-256-GCM — authenticated; any bit-flip in the ciphertext or header is detected |
| Key derivation | PBKDF2-SHA256 |
| Default iterations | 200,000 (OWASP 2023 minimum for PBKDF2-SHA256) |
| Iteration floor | 1,000 — `encrypt()` rejects lower values (typo guard) |
| Iteration ceiling | 10,000,000 — `decrypt()` rejects higher values in the header (DoS guard) |
| Dependencies | `@noble/ciphers` + `@noble/hashes` — [Cure53-audited](https://cure53.de/pentest-report_noble-crypto.pdf) |

```typescript
// Custom iteration count (higher = more brute-force resistant, slower)
const cid = await meshkit.upload(data, {
  encrypt: { password: PASSWORD, iterations: 600_000 },
});
```

### Standalone encrypt / decrypt

If you need to encrypt bytes outside of an upload/retrieve flow:

```typescript
import { encrypt, decrypt, isEncryptedPayload, DEFAULT_ITERATIONS } from '@ipfs-meshkit/meshkit';

const payload = await encrypt(data, { password: PASSWORD });
console.log(isEncryptedPayload(payload)); // true

const recovered = await decrypt(payload, PASSWORD);
```

---

## Usage

### Local Kubo daemon (recommended for Node.js servers)

```typescript
import { readFile } from 'node:fs/promises';
import { init, setupGracefulShutdown } from '@ipfs-meshkit/meshkit';

const { meshkit, localNode } = await init({ localNode: true });
setupGracefulShutdown(localNode);

const file = await readFile('./document.pdf');
const cid = await meshkit.upload(file);
await meshkit.pin(cid);

const pins = await meshkit.listPins();
console.log('pinned CIDs:', pins.length);
```

### Remote Kubo only (no local daemon spawn)

```typescript
import { init } from '@ipfs-meshkit/meshkit';

const { meshkit } = await init({
  nodes: ['https://kubo.example.com:5001'],
});

const cid = await meshkit.upload(new Uint8Array([1, 2, 3]));
```

### Multi-node failover

Meshkit health-checks all nodes at init time and routes requests through the first healthy one. If it fails mid-operation, the next node is tried automatically.

```typescript
import { init } from '@ipfs-meshkit/meshkit';

const { meshkit } = await init({
  localNode: true,
  nodes: ['https://backup1.example.com:5001', 'https://backup2.example.com:5001'],
});

await meshkit.upload(new TextEncoder().encode('stored across failover nodes'));
```

### IPNS — mutable pointers

IPNS lets you publish a stable name that always points to your latest content. Only available on the Kubo path.

```typescript
import { init, IPNS_TTL_FAST } from '@ipfs-meshkit/meshkit';

const { meshkit } = await init({ localNode: true });

// Create a named key — the key name becomes a stable IPNS address
await meshkit.generateKey('my-app');

const v1 = new TextEncoder().encode('version 1');
const cid = await meshkit.upload(v1);
await meshkit.pin(cid);

// Publish: /ipns/<name> now resolves to this CID
const { name } = await meshkit.publishName(cid, {
  key: 'my-app',
  ttl: IPNS_TTL_FAST,
});

// Later — resolve and fetch in one call
const latest = await meshkit.resolveAndRetrieve(`/ipns/${name}`);
console.log(new TextDecoder().decode(latest)); // version 1
```

### Server shutdown hook

```typescript
import { init, setupGracefulShutdown } from '@ipfs-meshkit/meshkit';

const { meshkit, localNode } = await init({ localNode: true });

setupGracefulShutdown(localNode, {
  onShutdown: async () => {
    // close HTTP servers, DB connections, etc.
  },
});
```

### S3-compatible storage — fil.one preset

`createFilOneClient` is a convenience preset over `createS3Client` that defaults `endpoint` to `https://eu-west-1.s3.fil.one`. Get your API key and bucket at [app.fil.one](https://app.fil.one).

```typescript
import { createFilOneClient } from '@ipfs-meshkit/meshkit';

const client = createFilOneClient({
  accessKeyId: process.env.FIL_ACCESS_KEY!,    // format: FHXXXXXXXXXXXXXXXX
  secretAccessKey: process.env.FIL_SECRET_KEY!,
  bucket: 'my-invoices',
  // endpoint defaults to 'https://eu-west-1.s3.fil.one'
});

const cid = await client.upload(new TextEncoder().encode('invoice data'));
const retrieved = await client.retrieve(cid);
```

### S3-compatible storage — custom endpoint (Lighthouse, Filebase, 4EVERLAND, …)

`createS3Client` works with any S3-compatible service. Pass the endpoint explicitly.

```typescript
import { createS3Client } from '@ipfs-meshkit/meshkit';

// Lighthouse
const lighthouse = createS3Client({
  accessKeyId: process.env.LH_KEY!,
  secretAccessKey: process.env.LH_SECRET!,
  bucket: 'my-bucket',
  endpoint: 'https://gateway.lighthouse.storage',
});

// Filebase
const filebase = createS3Client({
  accessKeyId: process.env.FB_KEY!,
  secretAccessKey: process.env.FB_SECRET!,
  bucket: 'my-bucket',
  endpoint: 'https://s3.filebase.com',
});

const cid = await lighthouse.upload(new TextEncoder().encode('data'));
```

### Listing stored objects

On S3 clients, `list()` queries the bucket and returns metadata for every stored object. `listPins()` returns just the CID strings (same data, different shape).

```typescript
import { createS3Client } from '@ipfs-meshkit/meshkit';

const client = createS3Client({ /* config */ });

// Full metadata
const objects = await client.list();
for (const obj of objects) {
  console.log(obj.cid);        // 'bafkrei...'
  console.log(obj.size);       // 1024 (bytes)
  console.log(obj.uploadedAt); // '2026-07-22T10:00:00.000Z'
}

// CID strings only
const cids = await client.listPins();
```

> `list()` is **not available on Kubo clients** — it throws `MeshkitError`. Use `listPins()` on the Kubo path.

### In an Ionic / Angular service

```typescript
import { Injectable } from '@angular/core';
import { createFilOneClient, type MeshkitClient } from '@ipfs-meshkit/meshkit';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class InvoiceStorageService {
  private client: MeshkitClient = createFilOneClient(environment.filOne);

  async uploadInvoice(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.client.upload(bytes); // returns CID — store this in your DB
  }

  async getInvoice(cid: string): Promise<Blob> {
    const bytes = await this.client.retrieve(cid);
    return new Blob([bytes], { type: 'application/pdf' });
  }

  async listInvoices() {
    return this.client.list(); // [{ cid, size, uploadedAt }, ...]
  }
}
```

### Helia (in-process IPFS node, Node.js)

`createHeliaClient` runs the `MeshkitClient` API on an in-process [Helia](https://github.com/ipfs/helia) node — no Kubo daemon. The Helia packages are **optional peer dependencies**, so install them only if you use this client:

```bash
npm install helia@^7 @helia/unixfs@^8 @helia/ipns@^10 @libp2p/crypto @libp2p/peer-id
```

```typescript
import { createHelia } from 'helia';
import { createHeliaClient } from '@ipfs-meshkit/meshkit';

// Use Helia's default libp2p services — the keychain (IPNS keys) is one of them.
const helia = await createHelia();
await helia.start();                                    // Helia 7 does not auto-start; IPNS/keys need the started libp2p
const client = await createHeliaClient(helia);

const cid = await client.upload(new TextEncoder().encode('hello'));
await client.pin(cid);

const key = await client.generateKey('site');           // { id: '12D3Koo…', name: 'site' }
await client.publishName(cid, { key: 'site' });         // { name: '12D3Koo…', value: '/ipfs/<cid>' }
await client.resolveName('site');                       // '/ipfs/<cid>' — resolve by key name
await client.list();                                    // [{ cid, size, uploadedAt }]

await helia.stop();                                     // you own the node's lifecycle
```

**Node.js only.** This client is developed and tested on Node.js 22 with Helia 7 (`helia@^7`, `@helia/unixfs@^8`, `@helia/ipns@^10`). The browser entry re-exports it, but it has not been tested in a browser. Pass `{ offline: true }` to keep IPNS publish/resolve and block reads off the network (no DHT, no peers) — useful for tests and air-gapped use.

**Persistence.** Pins, IPNS records and keys live in the Helia datastore and blocks in its blockstore. The defaults are in-memory; pass `blockstore: new FsBlockstore(...)` and `datastore: new FsDatastore(...)` (or LevelDB) to `createHelia` to survive restarts.

**How IPNS key names map to `12D3Koo…`.** A key *name* (`'site'`) is a local keychain label. Its IPNS *name* is the PeerID of the key's public key: `12D3Koo…` for Ed25519, `Qm…` for RSA — the same form Kubo returns. `generateKey` / `listKeys` / `publishName` return that PeerID as `id` / `name`. `resolveName(x)` first tries `x` as a key label and, if there is none, treats it as an IPNS name, so both `resolveName('site')` and `resolveName('12D3Koo…')` work. The keychain's own `KeyInfo.id` (a `Qm…` hash even for Ed25519) is *not* a resolvable IPNS name and is never returned.

**Semantics that differ from Kubo:**
- `countPins()` counts pinned **roots**; `indirect` is always `0`. A finite-depth pin counts as `direct`, an infinite-depth pin as `recursive`.
- `list()` returns every pinned root as a `StoredObject`. `uploadedAt` is the time `client.pin()` ran (stored in the pin's metadata); roots pinned by other tools report the Unix epoch.
- `pin()` of an already-pinned CID is a no-op, as on Kubo.
- `publishName` accepts Go-style durations (`'10s'`, `'1h30m'`) for `lifetime` / `ttl`; the `resolve` option is ignored.
- Publishing **without** `offline: true` pushes the record to the DHT / routers and can take tens of seconds.

### Low-level single-node client (no failover)

```typescript
import { createMeshkitClient } from '@ipfs-meshkit/meshkit';

const client = createMeshkitClient({ apiUrl: 'http://127.0.0.1:5001' });
const cid = await client.upload(new Uint8Array([1, 2, 3]));
```

### CommonJS

```javascript
const { init } = require('@ipfs-meshkit/meshkit');

(async () => {
  const { meshkit } = await init({ nodes: ['http://127.0.0.1:5001'] });
  console.log(await meshkit.upload(Buffer.from('hello')));
})();
```

---

## API overview

### Kubo / IPFS

| Export | Purpose |
|---|---|
| `init(options?)` | Main entry — connect to Kubo nodes, optionally spawn local daemon |
| `meshkit.upload(bytes)` | Upload bytes; returns CID string; uses failover |
| `meshkit.retrieve(cid)` | Retrieve bytes by CID; uses failover |
| `meshkit.pin(cid)` | Pin a CID on the primary node |
| `meshkit.listPins()` | List all pinned CIDs on the primary node |
| `meshkit.publishName` / `resolveName` / `resolveAndRetrieve` | IPNS mutable pointers |
| `meshkit.generateKey` / `listKeys` | IPNS keystore management |
| `setupGracefulShutdown` | Stop managed Kubo on Ctrl+C / SIGTERM |
| `createMeshkitClient(config)` | Single-node Kubo RPC client (no failover) |
| `startIPFSNode` / `stopIPFSNode` | Low-level daemon lifecycle control |

### S3-compatible object storage

| Export | Purpose |
|---|---|
| `createS3Client(config)` | `MeshkitClient` backed by any S3-compatible service |
| `createFilOneClient(config)` | Preset of `createS3Client` for fil.one; `endpoint` defaults to `eu-west-1.s3.fil.one` |
| `client.upload(bytes)` | PUT bytes to the bucket; CID computed locally and used as the object key |
| `client.retrieve(cid)` | GET bytes from the bucket by CID key |
| `client.list()` | List all objects: `{ cid, size, uploadedAt }[]`; handles pagination |
| `client.listPins()` | Same as `list()` but returns only the CID strings |
| `client.pin(cid)` | No-op — safe to call, does nothing (no pin layer on object stores) |
| `client.healthCheck()` | HEAD the bucket — confirms credentials and bucket exist |
| `S3StorageConfig` | Type: `{ accessKeyId, secretAccessKey, bucket, endpoint }` |
| `FilOneConfig` | Type: `{ accessKeyId, secretAccessKey, bucket, endpoint? }` |
| `StoredObject` | Type: `{ cid: string; size: number; uploadedAt: string }` |

> IPNS operations (`publishName`, `resolveName`, `resolveAndRetrieve`, `generateKey`, `listKeys`) are **not supported on S3 clients** and throw `MeshkitError`.

### Helia (in-process node)

| Export | Purpose |
|---|---|
| `createHeliaClient(helia, config?)` | `MeshkitClient` backed by a Helia node; async (loads the optional peer deps lazily) |
| `HeliaClientConfig` | Type: `{ offline?: boolean }` |

See [Helia (in-process IPFS node, Node.js)](#helia-in-process-ipfs-node-nodejs).

### Kubo vs S3 vs Helia

| | Kubo (`createMeshkitClient` / `init`) | S3 (`createS3Client` / `createFilOneClient`) | Helia (`createHeliaClient`) |
|---|---|---|---|
| Backend | Kubo daemon over RPC | S3-compatible bucket | In-process Helia node |
| Runs in | Node.js | Node, browser, Ionic, React Native | Node.js (tested on Node 22) |
| `upload` | `ipfs.add`, not pinned | PUT, CID computed locally | `unixfs.addBytes`, not pinned |
| `retrieve` | `ipfs.cat` | GET by CID key | `unixfs.cat` (network via Helia's block brokers) |
| `pin` | `pin.add` | no-op | `pins.add` (repeat pin is a no-op) |
| `listPins` | all pins (incl. indirect) | all object keys | pinned roots |
| `countPins` | by type: direct / recursive / indirect | all objects as `recursive` | roots only; `indirect` is `0` |
| `list` | throws `MeshkitError` — use `listPins` | `{ cid, size, uploadedAt }[]` | pinned roots as `{ cid, size, uploadedAt }[]` |
| `healthCheck` | `ipfs.id()` | HEAD the bucket | node status is `started` |
| `publishName` / `resolveName` | yes | throws `MeshkitError` | yes (`offline: true` skips the DHT) |
| `generateKey` / `listKeys` | Kubo keystore | throws `MeshkitError` | libp2p keychain |
| Failover across nodes | yes, via `init` | no | no |
| Needs a daemon / account | Kubo daemon | bucket + credentials | neither |

### Constants and utilities

| Export | Purpose |
|---|---|
| `IPNS_TTL_FAST` / `IPNS_TTL_DEFAULT` | TTL constants for IPNS publish |
| `extractCidFromPath(path)` | Extract CID string from `/ipfs/<cid>` path |
| `toIpfsPath(cid)` / `toIpnsPath(name)` | Normalize to `/ipfs/` or `/ipns/` path |
| `MeshkitError` / `MeshkitNodeError` | Error classes |

### Encryption

| Export | Purpose |
|---|---|
| `encrypt(data, { password, iterations? })` | Encrypt bytes with AES-256-GCM / PBKDF2-SHA256; returns EMSH payload |
| `decrypt(data, password)` | Decrypt an EMSH payload; throws `MeshkitError` on wrong password or tampering |
| `isEncryptedPayload(data)` | Returns `true` if `data` starts with the EMSH magic bytes |
| `DEFAULT_ITERATIONS` | `200_000` — OWASP 2023 minimum for PBKDF2-SHA256 |
| `EncryptOptions` | Type: `{ password: string; iterations?: number }` (iterations ≥ 1,000) |

Both `upload()` and `retrieve()` accept inline encryption options so you do not need to call `encrypt` / `decrypt` directly in most cases:

```typescript
// Upload option
meshkit.upload(bytes, { encrypt: { password, iterations? } })

// Retrieve option
meshkit.retrieve(cid, { password })
```

TypeScript types are included — no `@types/` package needed:

```typescript
import type {
  MeshkitClient,
  StoredObject,
  S3StorageConfig,
  FilOneConfig,
  IPFSNodeHandle,
} from '@ipfs-meshkit/meshkit';
```

---

## Documentation

- [GitHub repository](https://github.com/IPFS-Meshkit/meshkit0)
- [Kubo install guide](https://docs.ipfs.tech/install/)
- [fil.one dashboard](https://app.fil.one) — create buckets and API keys
- [Security policy](https://github.com/IPFS-Meshkit/meshkit0/blob/main/SECURITY.md)

## Support

- [GitHub Issues](https://github.com/IPFS-Meshkit/meshkit0/issues) — bugs and feature requests

## Credits

Open source project by **IPFS Meshkit Contributors**:

- [Anurag Pandey](https://github.com/anurag-p6) — primary development
- [Manu Sheel Gupta](https://github.com/seetadev) — project lead

## License

[MIT](https://github.com/IPFS-Meshkit/meshkit0/blob/main/LICENSE)
