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

export default defineConfig([
  // Node.js build — full surface including @ipfs-meshkit/node (child_process, path).
  {
    entry: { index: path.join(root, 'packages/meshkit/src/index.ts') },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'es2022',
    esbuildOptions(options) {
      options.alias = sharedAlias;
    },
    dts: sharedDts,
    noExternal: [/^@ipfs-meshkit\//],
    external: [...external],
  },
  // Browser build — only @ipfs-meshkit/core; no Node.js built-ins.
  {
    entry: { 'index.browser': path.join(root, 'packages/meshkit/src/index.browser.ts') },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    target: 'es2022',
    esbuildOptions(options) {
      options.alias = sharedAlias;
    },
    dts: sharedDts,
    noExternal: [/^@ipfs-meshkit\//],
    external: [...external],
  },
]);
