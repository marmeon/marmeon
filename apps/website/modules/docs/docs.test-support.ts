import { resolve } from 'node:path';
import docsConfig, { type DocsPageEntry } from '../../docs.config.ts';
import type { SearchResult } from './search.ts';

export const repo = resolve(import.meta.dirname, '../../../..');

/** Every page of the docs in the order of docs.config.ts — across the sections. */
export const ENTRIES = docsConfig.sections.flatMap((section) => section.pages);
export const fileOf = (entry: DocsPageEntry) => entry.file ?? `docs/${entry.slug}.md`;
export const SECTIONS = [
  'Prologue',
  'Getting Started',
  'Recipes',
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
