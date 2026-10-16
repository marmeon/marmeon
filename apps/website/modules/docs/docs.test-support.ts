import { resolve } from 'node:path';
import docsConfig, { type DocsPageEntry } from '../../docs.config.ts';
import type { SearchResult } from './search.ts';

// Vitest's 5 s is too short under load: more time on CI runners only (CI=true).
export const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

export const repo = resolve(import.meta.dirname, '../../../..');

/** Every page of the docs in the order of docs.config.ts — across the sections. */
export const ENTRIES = docsConfig.sections.flatMap((section) => section.pages);
export const fileOf = (entry: DocsPageEntry) => entry.file ?? `docs/${entry.slug}.md`;
export const SECTIONS = [
  'Prologue',
  'Getting Started',
  'Architecture Concepts',
  'The Basics',
  'Frontend',
  'Digging Deeper',
  'Security',
  'Database',
  'Testing',
  'Tools',
];

export const results = (response: { page(): { props: unknown } | undefined }) => (response.page()!.props as { results: SearchResult[] }).results;
