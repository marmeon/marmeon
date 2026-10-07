import { token } from '@marmeon/core';
import type { StorageOptions } from './config.ts';
import type { StorageDependencies } from './storage.ts';

/** The resolved configuration and what disks are built with — the real `Storage` and the fake share it. */
export interface StorageSetup {
  readonly options: StorageOptions;
  readonly dependencies: StorageDependencies;
}
export const StorageSetup = token<StorageSetup>('StorageSetup');
