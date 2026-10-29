// Browser / Capacitor / React Native entry — omits @ipfs-meshkit/node
// (child_process, path) and the Node.js-only init / shutdown helpers.
export type {
  MeshkitClient,
  MeshkitConfig,
  MeshkitInitOptions,
  StoredObject,
  IpnsDuration,
  IpnsKey,
  IpnsKeyGenOptions,
  IpnsPublishOptions,
  IpnsPublishResult,
  IpnsResolveOptions,
} from '@ipfs-meshkit/core';
export {
  MeshkitError,
  Meshkit,
  createMeshkitClient,
  createS3Client,
  createFilOneClient,
  createHeliaClient,
  IPNS_TTL_DEFAULT,
  IPNS_TTL_FAST,
  extractCidFromPath,
  toIpfsPath,
  toIpnsPath,
  encrypt,
  decrypt,
  isEncryptedPayload,
  DEFAULT_ITERATIONS,
} from '@ipfs-meshkit/core';
export type { EncryptOptions, HeliaClientConfig, S3StorageConfig, FilOneConfig } from '@ipfs-meshkit/core';
