/**
 * Container isolation module.
 *
 * Provides Docker-based sandboxing for agent processes.
 */

export { ensureImage, imageExists, buildImage, FULL_IMAGE_TAG } from './image.js';
export {
  findDockerSocket,
  isDockerAvailable,
  createContainer,
  buildDockerStartCommand,
  injectCredentials,
  injectFile,
  extractFile,
  isContainerRunning,
  containerExists,
  stopContainer,
  removeContainer,
  startContainerBackground,
  execInContainer,
  WORKSPACE_DIR,
} from './manager.js';
export type { ContainerCreateOptions } from './manager.js';
export { ContainerSync } from './sync.js';
export type { ContainerSyncOptions } from './sync.js';
