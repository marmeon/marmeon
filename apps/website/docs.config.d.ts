/**
 * The navigation of the docs: the sections with their pages (`/docs/<slug>`), in reading order. Checked against the repository
 * when the app boots: a `docs/*.md` without its entry here, or an entry without its file, stops the start. The packages' READMEs
 * are no pages — they are cards for npm that link here.
 */
/** A page of the docs: `/docs/<slug>`, its file `docs/<slug>.md` — or a policy at the root (`file`). */
export interface DocsPageEntry {
    readonly slug: string;
    /** Its name in the navigation (the page's title is its `#` heading). */
    readonly label: string;
    /** A file at the root instead of `docs/<slug>.md`: `UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`. */
    readonly file?: string;
    /** A record of changes (`UPGRADING.md`): its sections come after every other hit of a search. */
    readonly changes?: true;
}
/**
 * A part of the navigation and of the start page, its pages in reading order. Previous and next lead through every page of every
 * section in this order. Every `docs/*.md` needs its entry — an unlisted page stops the start.
 */
export interface DocsSection {
    readonly title: string;
    readonly pages: readonly DocsPageEntry[];
}
export interface DocsDefinition {
    readonly sections: readonly DocsSection[];
}
export declare function defineDocs(docs: DocsDefinition): DocsDefinition;
declare const _default: DocsDefinition;
export default _default;
//# sourceMappingURL=docs.config.d.ts.map