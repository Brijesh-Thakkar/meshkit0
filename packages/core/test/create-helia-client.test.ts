import { MemoryBlockstore } from 'blockstore-core';
import { MemoryDatastore } from 'datastore-core';
import { createHelia, type Helia } from 'helia';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHeliaClient } from '../src/create-helia-client.js';
import { MeshkitError } from '../src/types.js';
import type { MeshkitClient } from '../src/types.js';

/**
 * Real in-memory Helia with no transports, no listen addresses and no peer
 * discovery, so nothing can reach the network. IPNS runs with `offline: true`.
 * The default libp2p services are kept: the keychain is one of them.
 */
async function createOfflineHelia(start = true): Promise<Helia> {
  return createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    start,
    libp2p: { addresses: { listen: [] }, transports: [], peerDiscovery: [] },
  });
}

const PASSWORD = 'test-password-32chars-minimum-ok';
const text = (s: string) => new TextEncoder().encode(s);

describe('createHeliaClient (offline, in-memory Helia)', () => {
  let helia: Helia;
  let client: MeshkitClient;

  beforeAll(async () => {
    helia = await createOfflineHelia();
    client = await createHeliaClient(helia, { offline: true });
  });

  afterAll(async () => {
    await helia.stop();
  });

  describe('upload / retrieve', () => {
    it('round-trips bytes', async () => {
      const cid = await client.upload(text('hello helia'));
      expect(new TextDecoder().decode(await client.retrieve(cid))).toBe('hello helia');
    });

    it('encrypts on upload and decrypts with a password', async () => {
      const cid = await client.upload(text('secret'), { encrypt: { password: PASSWORD } });
      const raw = await client.retrieve(cid);
      expect(new TextDecoder().decode(raw)).not.toBe('secret');
      expect(new TextDecoder().decode(await client.retrieve(cid, { password: PASSWORD }))).toBe(
        'secret',
      );
    });

    it('does not pin on upload', async () => {
      await client.upload(text('unpinned'));
      expect((await client.countPins()).total).toBe(0);
    });
  });

  describe('pins', () => {
    it('counts a pinned multi-block upload as one root pin', async () => {
      const before = (await client.countPins()).total;
      const big = new Uint8Array(3_000_000).map((_, i) => i % 251); // > 1 MiB: many blocks
      const cid = await client.upload(big);
      await client.pin(cid);

      const counts = await client.countPins();
      expect(counts.total - before).toBe(1);
      expect(counts.indirect).toBe(0);
      expect(await client.listPins()).toContain(cid);
    });

    it('treats a repeat pin as a no-op', async () => {
      const cid = await client.upload(text('pin me twice'));
      await client.pin(cid);
      await expect(client.pin(cid)).resolves.toBeUndefined();
    });

    it('paginates listPins with offset and limit', async () => {
      for (const s of ['p1', 'p2', 'p3']) {
        await client.pin(await client.upload(text(`page-${s}`)));
      }
      const all = await client.listPins();
      expect(await client.listPins({ limit: 2 })).toEqual(all.slice(0, 2));
      expect(await client.listPins({ offset: 1, limit: 2 })).toEqual(all.slice(1, 3));
    });
  });

  describe('list', () => {
    it('returns each pinned root as a StoredObject with size and pin time', async () => {
      const payload = new Uint8Array(2_500_000).fill(7);
      const cid = await client.upload(payload);
      const t0 = Date.now();
      await client.pin(cid);

      const entry = (await client.list()).find((o) => o.cid === cid);
      expect(entry).toBeDefined();
      expect(Object.keys(entry!).sort()).toEqual(['cid', 'size', 'uploadedAt']);
      expect(entry!.size).toBe(payload.length);
      expect(new Date(entry!.uploadedAt).toISOString()).toBe(entry!.uploadedAt);
      expect(Date.parse(entry!.uploadedAt)).toBeGreaterThanOrEqual(t0 - 1);
      expect(Date.parse(entry!.uploadedAt)).toBeLessThanOrEqual(Date.now());
    });

    it('lists exactly the pinned roots, not their child blocks', async () => {
      expect((await client.list()).map((o) => o.cid).sort()).toEqual(
        (await client.listPins()).sort(),
      );
    });

    it('reports the Unix epoch for roots pinned outside Meshkit', async () => {
      const { unixfs } = await import('@helia/unixfs');
      const cid = await unixfs(helia).addBytes(text('pinned elsewhere'));
      for await (const _ of helia.pins.add(cid)) {
        // drain
      }
      const entry = (await client.list()).find((o) => o.cid === cid.toString());
      expect(entry?.uploadedAt).toBe(new Date(0).toISOString());
      expect(entry?.size).toBe('pinned elsewhere'.length);
    });
  });

  describe('list (non-UnixFS roots)', () => {
    it('falls back to the root block length', async () => {
      const [{ CID }, { sha256 }, json] = await Promise.all([
        import('multiformats/cid'),
        import('multiformats/hashes/sha2'),
        import('multiformats/codecs/json'),
      ]);
      const bytes = json.encode({ hello: 'json' });
      const cid = CID.createV1(json.code, await sha256.digest(bytes));
      await helia.blockstore.put(cid, bytes);
      for await (const _ of helia.pins.add(cid)) {
        // drain
      }
      expect((await client.list()).find((o) => o.cid === cid.toString())?.size).toBe(bytes.length);
    });
  });

  describe('keys', () => {
    it('generates an Ed25519 key in the keychain and lists it', async () => {
      const key = await client.generateKey('test-key');
      expect(key.name).toBe('test-key');
      expect(key.id).toMatch(/^12D3Koo/); // Ed25519 PeerID, the same form Kubo returns

      const keys = await client.listKeys();
      expect(keys.map((k) => k.name)).toEqual(expect.arrayContaining(['self', 'test-key']));
      expect(keys.find((k) => k.name === 'test-key')).toEqual(key);
    });

    it('rejects a duplicate key name', async () => {
      await client.generateKey('dup-key');
      await expect(client.generateKey('dup-key')).rejects.toThrow();
    });

    it('generates an RSA key', async () => {
      const key = await client.generateKey('rsa-key', { type: 'rsa' });
      expect(key.name).toBe('rsa-key');
    });
  });

  describe('IPNS (offline, no DHT)', () => {
    it('publishes under a named key and resolves it by key name', async () => {
      const key = await client.generateKey('site');
      const cid = await client.upload(text('v1'));

      const published = await client.publishName(cid, { key: 'site', lifetime: '1h', ttl: '10s' });
      expect(published).toEqual({ name: key.id, value: `/ipfs/${cid}` });
      expect(await client.resolveName('site')).toBe(`/ipfs/${cid}`);
    });

    it('resolves by IPNS name when it is not a keychain label', async () => {
      const key = await client.generateKey('by-id');
      const cid = await client.upload(text('v-by-id'));
      await client.publishName(cid, { key: 'by-id' });

      expect(await client.resolveName(key.id)).toBe(`/ipfs/${cid}`);
      expect(await client.resolveName(`/ipns/${key.id}`)).toBe(`/ipfs/${cid}`);
    });

    it('republishing moves the pointer', async () => {
      await client.generateKey('mutable');
      const a = await client.upload(text('a'));
      const b = await client.upload(text('b'));
      await client.publishName(a, { key: 'mutable' });
      await client.publishName(`/ipfs/${b}`, { key: 'mutable' });
      expect(await client.resolveName('mutable')).toBe(`/ipfs/${b}`);
    });

    it('publishes with the default "self" key', async () => {
      const cid = await client.upload(text('self-published'));
      const { name } = await client.publishName(cid);
      expect(name).toBe((await client.listKeys()).find((k) => k.name === 'self')!.id);
      expect(await client.resolveName('self')).toBe(`/ipfs/${cid}`);
    });

    it('resolveAndRetrieve returns the published bytes', async () => {
      await client.generateKey('doc');
      const cid = await client.upload(text('latest doc'));
      await client.publishName(cid, { key: 'doc' });
      expect(new TextDecoder().decode(await client.resolveAndRetrieve('doc'))).toBe('latest doc');
    });

    it('fails to resolve a name with no local record', async () => {
      const stranger = await createOfflineHelia(false);
      const other = await createHeliaClient(stranger, { offline: true });
      const { id } = await other.generateKey('elsewhere');
      await other.publishName(await other.upload(text('x')), { key: 'elsewhere' });
      await stranger.stop();

      await expect(client.resolveName(id)).rejects.toThrow();
    });

    it('rejects an invalid lifetime', async () => {
      await expect(client.publishName(await client.upload(text('t')), { lifetime: 'soon' })).rejects.toThrow(
        /Invalid duration/,
      );
    });

    // Publishing without `offline` pushes the record to the DHT / delegated routers,
    // which takes tens of seconds (44s measured against the public network) and needs
    // internet access, so it can neither run under the 10s limit nor in CI.
    it.skip('publishes to the network (needs internet and exceeds the 10s test limit)', () => {});
  });

  describe('healthCheck', () => {
    it('passes for a started node', async () => {
      await expect(client.healthCheck()).resolves.toBeUndefined();
    });

    it('throws MeshkitError for a node that is not started', async () => {
      const stopped = await createOfflineHelia(false);
      const c = await createHeliaClient(stopped, { offline: true });
      await expect(c.healthCheck()).rejects.toThrow(MeshkitError);
    });
  });

  it('reports a clear error when the node has no keychain service', async () => {
    const bare = await createHelia({
      blockstore: new MemoryBlockstore(),
      datastore: new MemoryDatastore(),
      start: false,
      libp2p: { addresses: { listen: [] }, transports: [], peerDiscovery: [], services: {} },
    });
    const c = await createHeliaClient(bare, { offline: true });
    await expect(c.listKeys()).rejects.toThrow(/no keychain service/);
  });
});
