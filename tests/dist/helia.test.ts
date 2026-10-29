import { MemoryBlockstore } from 'blockstore-core';
import { MemoryDatastore } from 'datastore-core';
import { createHelia, type Helia } from 'helia';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The ESM build with the *user's* multiformats@14 (the copy resolved from this repo's
// root) and a real Helia. Run via `npm run test:dist`.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const { createHeliaClient } = await import(path.join(dist, 'index.js'));

describe('built ESM createHeliaClient with a user-supplied multiformats@14 CID', () => {
  let helia: Helia;
  let client: Awaited<ReturnType<typeof createHeliaClient>>;
  const bytes = new TextEncoder().encode('cid from the user multiformats');

  beforeAll(async () => {
    helia = await createHelia({
      blockstore: new MemoryBlockstore(),
      datastore: new MemoryDatastore(),
      libp2p: { addresses: { listen: [] }, transports: [], peerDiscovery: [] },
    });
    await helia.start(); // Helia 7 does not start itself; libp2p (keychain) exists only once started
    client = await createHeliaClient(helia, { offline: true });
  });

  afterAll(async () => {
    await helia.stop();
  });

  it('retrieve accepts a CID object created by the caller', async () => {
    const cid = CID.parse(await client.upload(bytes));
    expect(cid).toBeInstanceOf(CID);
    expect(await client.retrieve(cid as unknown as string)).toEqual(bytes);
  });

  it('pin accepts a CID object created by the caller', async () => {
    const cid = CID.createV1(raw.code, await sha256.digest(bytes)); // same bytes -> same raw CID
    expect(cid.toString()).toBe(await client.upload(bytes));
    await client.pin(cid as unknown as string);
    expect(await client.listPins()).toContain(cid.toString());
  });

  it('publishName accepts a CID object created by the caller', async () => {
    const cid = CID.parse(await client.upload(bytes));
    const { value } = await client.publishName(cid as unknown as string);
    expect(value).toBe(`/ipfs/${cid}`);
  });
});
