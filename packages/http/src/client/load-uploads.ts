/**
 * Uploads — `navigator.load(loadUploads)`: an adapter loads them where a file input renders (`<FileInput>`), before a
 * file is chosen. Their chunk brings the XHR code with it. A module of its own (not `lazy.ts`, which every app's first
 * download has): only an app with a file input carries even this loader.
 */
import type { Feature } from './feature.ts';
import type { UploadsFeature } from './features/uploads.ts';

export const loadUploads = (): Promise<Feature<UploadsFeature>> => import('./features/uploads.ts').then((module) => module.uploads);
