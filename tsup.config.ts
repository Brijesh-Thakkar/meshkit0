import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const root = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  '@ipfs-meshkit/core': path.join(root, 'packages/core/src/index.ts'),
  '@ipfs-meshkit/node': path.join(root, 'packages/node/src/index.ts'),
};

const sharedDts = {
  compilerOptions: {
    composite: false,
    incremental: false,
    ignoreDeprecations: '6.0',
    paths: {
      '@ipfs-meshkit/core': ['./packages/core/src/index.ts'],
      '@ipfs-meshkit/node': ['./packages/node/src/index.ts'],
    },
    baseUrl: '.',
  },
};

const external = [
  'kubo-rpc-client',
  'aws4fetch',
  'multiformats',
  '@noble/ciphers',
  '@noble/hashes',
  // Optional peer deps of createHeliaClient(), imported lazily.
  'helia',
  '@helia/unixfs',
  '@helia/ipns',
  '@libp2p/crypto',
  '@libp2p/peer-id',
];

/**
 * multiformats is external in ESM so it dedupes with the copy Helia needs (a CID from
 * one copy fails `instanceof` in another). The CJS bundles inline it instead: v13 has no
 * `module-sync` export condition, so `require('multiformats/cid')` throws on Node 22.
 */
function target(entry: string, format: 'esm' | 'cjs', first = false) {
  return {
    entry: { [entry]: path.join(root, `packages/meshkit/src/${entry}.ts`) },
    format: [format],
    outDir: 'dist',
    clean: first,
    sourcemap: true,
    target: 'es2022' as const,
    esbuildOptions(options: { alias?: Record<string, string> }) {
      options.alias = sharedAlias;
    },
    dts: sharedDts,
    noExternal: format === 'cjs' ? [/^@ipfs-meshkit\//, /^multiformats(\/|$)/] : [/^@ipfs-meshkit\//],
    external: format === 'cjs' ? external.filter((name) => name !== 'multiformats') : external,
  };
}

export default defineConfig([
  // Node.js build — full surface including @ipfs-meshkit/node (child_process, path).
  target('index', 'esm', true),
  target('index', 'cjs'),
  // Browser build — only @ipfs-meshkit/core; no Node.js built-ins.
  target('index.browser', 'esm'),
  target('index.browser', 'cjs'),
]);
