import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Imports the *built* bundles, i.e. what `npm publish` ships. Run via
// `npm run test:dist` (builds first) — it fails if `dist/` is missing.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const PASSWORD = 'test-password-32chars-minimum-ok';

const entries = {
  'index.js (node, esm)': () => import(path.join(dist, 'index.js')),
  'index.browser.js (browser, esm)': () => import(path.join(dist, 'index.browser.js')),
  'index.cjs (node, cjs)': async () => createRequire(import.meta.url)(path.join(dist, 'index.cjs')),
  'index.browser.cjs (browser, cjs)': async () =>
    createRequire(import.meta.url)(path.join(dist, 'index.browser.cjs')),
};

describe.each(Object.entries(entries))('built %s', (_name, load) => {
  it('exports encrypt, decrypt, isEncryptedPayload and DEFAULT_ITERATIONS', async () => {
    const mod = await load();
    expect(mod.encrypt).toBeTypeOf('function');
    expect(mod.decrypt).toBeTypeOf('function');
    expect(mod.isEncryptedPayload).toBeTypeOf('function');
    expect(mod.DEFAULT_ITERATIONS).toBeTypeOf('number');
  });

  it('round-trips encrypt -> decrypt', async () => {
    const { encrypt, decrypt, isEncryptedPayload } = await load();
    const plaintext = new TextEncoder().encode('hello from dist');
    const sealed = await encrypt(plaintext, { password: PASSWORD, iterations: 1_000 });
    expect(isEncryptedPayload(sealed)).toBe(true);
    expect(new TextDecoder().decode(await decrypt(sealed, PASSWORD))).toBe('hello from dist');
  });

  it('exports createHeliaClient', async () => {
    expect((await load()).createHeliaClient).toBeTypeOf('function');
  });
});
