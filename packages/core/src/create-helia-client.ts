import { CID } from 'multiformats/cid';
import type { Helia } from 'helia';
import { decrypt, encrypt, isEncryptedPayload } from './crypto.js';
import { parseDurationMs } from './ipns/duration.js';
import { extractCidFromPath, toIpfsPath, toIpnsPath } from './ipns/paths.js';
import type {
  IpnsKey,
  IpnsKeyGenOptions,
  IpnsPublishOptions,
  IpnsResolveOptions,
} from './ipns/types.js';
import type {
  ListPinsOptions,
  MeshkitClient,
  PinCount,
  RetrieveOptions,
  StoredObject,
  UploadOptions,
} from './types.js';
import { MeshkitError } from './types.js';

export interface HeliaClientConfig {
  /**
   * Never touch the network: IPNS publish/resolve skip routing (no DHT) and
   * block reads fail instead of fetching from peers. Default: `false`.
   */
  offline?: boolean;
}

/** The slice of `@libp2p/keychain`'s `Keychain` this client uses. */
interface KeychainLike {
  importKey(name: string, key: unknown): Promise<IpnsKey>;
  exportKey(name: string): Promise<{ publicKey: unknown }>;
  listKeys(): Promise<IpnsKey[]>;
}

/** Pin metadata key holding the ISO 8601 time Meshkit pinned the root. */
const PINNED_AT = 'pinnedAt';

/** `uploadedAt` for pins that carry no Meshkit timestamp (pinned elsewhere). */
const UNKNOWN_TIME = new Date(0).toISOString();

/**
 * Parse a CID given as a string. A CID object from the caller's own multiformats
 * copy is coerced via `toString()`, so a different CID class never reaches Helia
 * (whose `instanceof CID` checks reject foreign copies).
 */
function parseCid(cid: string): CID {
  return CID.parse(String(cid));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Create a MeshkitClient backed by an in-process Helia node instead of a Kubo
 * daemon.
 *
 * Requires the optional peer dependencies `helia`, `@helia/unixfs`,
 * `@helia/ipns`, `@libp2p/crypto` and `@libp2p/peer-id`; they are imported
 * lazily so Kubo-only users never load them. The caller owns the node's
 * lifecycle (`helia.stop()`).
 *
 * The keychain is reached through `helia.libp2p.services.keychain`. libp2p exists
 * only once the node is started (`await helia.start()`) and only with Helia's
 * default libp2p services (do not pass `libp2p.services: {}`).
 */
export async function createHeliaClient(
  helia: Helia,
  config: HeliaClientConfig = {},
): Promise<MeshkitClient> {
  const [{ unixfs }, { ipns }, { generateKeyPair }, { peerIdFromPublicKey }] = await Promise.all([
    import('@helia/unixfs'),
    import('@helia/ipns'),
    import('@libp2p/crypto/keys'),
    import('@libp2p/peer-id'),
  ]);

  const offline = config.offline === true;
  const fs = unixfs(helia);

  // Helia 7 creates libp2p on start(), and `helia.libp2p` throws until then. IPNS and
  // the keychain are therefore resolved lazily, so a client can be created before
  // `helia.start()` and only IPNS/key calls need a started node.
  let namesInstance: ReturnType<typeof ipns> | undefined;
  function requireNames(): ReturnType<typeof ipns> {
    requireKeychain();
    // The IPNS components type wants a libp2p with the keychain service; it is present at runtime.
    namesInstance ??= ipns(helia as unknown as Parameters<typeof ipns>[0]);
    return namesInstance;
  }

  function requireKeychain(): KeychainLike {
    let keychain: KeychainLike | undefined;
    try {
      keychain = (helia as unknown as { libp2p: { services: { keychain?: KeychainLike } } }).libp2p
        .services.keychain;
    } catch (err) {
      throw new MeshkitError(
        'Helia node has no libp2p instance — call `await helia.start()` before using IPNS or keys',
        [err as Error],
      );
    }
    if (!keychain) {
      throw new MeshkitError(
        'Helia node has no keychain service — create it with the default libp2p services',
      );
    }
    return keychain;
  }

  /**
   * The IPNS name of a keychain key (its PeerID, e.g. `12D3Koo…` for Ed25519).
   * The keychain's own `KeyInfo.id` is a different hash and is not resolvable.
   */
  async function ipnsNameOf(keyName: string): Promise<string> {
    const { publicKey } = await requireKeychain().exportKey(keyName);
    return peerIdFromPublicKey(publicKey as Parameters<typeof peerIdFromPublicKey>[0]).toString();
  }

  async function catBytes(cid: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of fs.cat(parseCid(cid), offline ? { offline } : {})) {
      chunks.push(chunk);
    }
    return concatChunks(chunks);
  }

  async function resolveName(name: string, options?: IpnsResolveOptions): Promise<string> {
    // Look the name up as a keychain label first; otherwise treat it as an
    // IPNS name (PeerID / libp2p-key string), so third-party names resolve too.
    let publicKey;
    try {
      publicKey = (await requireKeychain().exportKey(name)).publicKey;
    } catch (err) {
      if (err instanceof MeshkitError) {
        throw err;
      }
      publicKey = undefined;
    }

    const key = publicKey ?? toIpnsPath(name); // @helia/ipns 10 takes a `/ipns/<name>` path string
    // @helia/ipns 10 yields each record it finds as an async iterable; the last is the newest.
    let value: string | undefined;
    for await (const result of requireNames().resolve(
      key as Parameters<ReturnType<typeof ipns>['resolve']>[0],
      {
        ...(offline ? { offline } : {}),
        ...(options?.nocache ? { nocache: true } : {}),
      },
    )) {
      value = result.value;
    }
    if (!value) {
      throw new MeshkitError(`IPNS name not found or empty result: ${toIpnsPath(name)}`);
    }
    return value;
  }

  /** Size in bytes of a pinned root: UnixFS size, else the root block's length. */
  async function sizeOf(cid: CID): Promise<number> {
    try {
      return Number((await fs.stat(cid, { offline: true })).size);
    } catch {
      // Not UnixFS (e.g. dag-cbor/json): the root block's byte length.
      let length = 0;
      for await (const chunk of helia.blockstore.get(cid, { offline: true })) {
        length += chunk.length;
      }
      return length;
    }
  }

  return {
    async upload(data: Uint8Array, options?: UploadOptions): Promise<string> {
      const payload = options?.encrypt ? await encrypt(data, options.encrypt) : data;
      // Not pinned, matching the Kubo client (`pin: false`).
      return (await fs.addBytes(payload)).toString();
    },

    async retrieve(cid: string, options?: RetrieveOptions): Promise<Uint8Array> {
      const raw = await catBytes(cid);
      if (options?.password && isEncryptedPayload(raw)) {
        return decrypt(raw, options.password);
      }
      return raw;
    },

    async pin(cid: string): Promise<void> {
      try {
        for await (const _ of helia.pins.add(parseCid(cid), {
          metadata: { [PINNED_AT]: new Date().toISOString() },
        })) {
          // drain: the generator does the pinning as it is consumed
        }
      } catch (err) {
        // Kubo's pin.add is idempotent; Helia throws on a repeat pin.
        if ((err as Error).name !== 'AlreadyPinnedError') {
          throw err;
        }
      }
    },

    async publishName(value: string, options?: IpnsPublishOptions) {
      requireKeychain();
      const keyName = options?.key ?? 'self';
      const cid = parseCid(extractCidFromPath(toIpfsPath(String(value))));
      await requireNames().publish(keyName, cid, {
        ...(options?.lifetime ? { lifetime: parseDurationMs(options.lifetime) } : {}),
        ...(options?.ttl ? { ttl: parseDurationMs(options.ttl) } : {}),
        ...(offline ? { offline } : {}),
      });
      return { name: await ipnsNameOf(keyName), value: toIpfsPath(cid.toString()) };
    },

    resolveName,

    async resolveAndRetrieve(name: string, options?: IpnsResolveOptions) {
      return catBytes(extractCidFromPath(await resolveName(name, options)).split('/')[0]!);
    },

    async generateKey(name: string, options?: IpnsKeyGenOptions): Promise<IpnsKey> {
      const kc = requireKeychain();
      const pair =
        options?.type === 'rsa'
          ? await generateKeyPair('RSA', options.size ?? 2048)
          : await generateKeyPair('Ed25519');
      await kc.importKey(name, pair);
      return { id: await ipnsNameOf(name), name };
    },

    async listKeys(): Promise<IpnsKey[]> {
      const keys = await requireKeychain().listKeys();
      return Promise.all(keys.map(async ({ name }) => ({ id: await ipnsNameOf(name), name })));
    },

    async listPins(options?: ListPinsOptions): Promise<string[]> {
      const cids: string[] = [];
      const offset = options?.offset ?? 0;
      let skipped = 0;
      for await (const pin of helia.pins.ls()) {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        cids.push(pin.cid.toString());
        if (options?.limit !== undefined && cids.length >= options.limit) {
          break;
        }
      }
      return cids;
    },

    /**
     * Counts pinned roots only: `helia.pins.ls()` yields one entry per pin,
     * not per block, so one pinned upload is 1. Helia does not enumerate
     * children, hence `indirect` is always 0. Infinite depth is `recursive`;
     * a finite depth is reported as `direct`.
     */
    async countPins(): Promise<PinCount> {
      const counts: PinCount = { direct: 0, recursive: 0, indirect: 0, total: 0 };
      for await (const pin of helia.pins.ls()) {
        if (pin.depth === Infinity) {
          counts.recursive++;
        } else {
          counts.direct++;
        }
        counts.total++;
      }
      return counts;
    },

    /**
     * Every pinned root as a {@link StoredObject}. `uploadedAt` is the time
     * Meshkit pinned it; roots pinned by other tools have no timestamp and
     * report the Unix epoch.
     */
    async list(): Promise<StoredObject[]> {
      const objects: StoredObject[] = [];
      for await (const pin of helia.pins.ls()) {
        const pinnedAt = pin.metadata?.[PINNED_AT];
        objects.push({
          cid: pin.cid.toString(),
          size: await sizeOf(pin.cid),
          uploadedAt: typeof pinnedAt === 'string' ? pinnedAt : UNKNOWN_TIME,
        });
      }
      return objects;
    },

    async healthCheck(): Promise<void> {
      if (helia.status !== 'started') {
        throw new MeshkitError(`Helia node is not running (status: ${helia.status})`);
      }
    },
  };
}
