import { defineDocs } from '../../docs.config.ts';

// docs.config.ts is typed: the sections with their pages, nothing else. (The pages are checked when the app boots — their files
// are on disk, not in the types.)
defineDocs({
  sections: [{ title: 'Prologue', pages: [{ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true }] }],
});

// @ts-expect-error — the sections are required (the docs are their pages)
defineDocs({});

// @ts-expect-error — a page needs its label in the navigation
defineDocs({ sections: [{ title: 'Prologue', pages: [{ slug: 'releases' }] }] });

defineDocs({
  sections: [],
  // @ts-expect-error — no groups of packages: the package READMEs are cards on npm, not pages of the docs
  groups: [{ title: 'Core', packages: ['core'] }],
});
