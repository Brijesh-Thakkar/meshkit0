import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

const workspaceAliases = {
  '@ipfs-meshkit/core': path.join(root, 'packages/core/src/index.ts'),
  '@ipfs-meshkit/node': path.join(root, 'packages/node/src/index.ts'),
  '@ipfs-meshkit/meshkit': path.join(root, 'packages/meshkit/src/index.ts'),
  '@ipfs-meshkit/mcp': path.join(root, 'packages/mcp/src/main.ts'),
};

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 10_000,
          setupFiles: ['./vitest.setup.unit.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dist',
          include: ['tests/dist/**/*.test.ts'],
          environment: 'node',
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 60_000,
          sequence: { concurrent: false },
          setupFiles: ['./vitest.setup.integration.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/test/**',
        'packages/*/src/index.ts',
        'packages/react-native/**',
        'packages/capacitor/**',
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65,
        statements: 75,
      },
    },
  },
});
