import type { DocsDefinition } from '../apps/website/docs.config.ts';
/** The policies the docs show as pages; they sit at the package's root so `../UPGRADING.md` in a page stays valid. */
export declare const ROOT_FILES: readonly ['UPGRADING.md', 'SECURITY.md', 'CONTRIBUTING.md'];
/** What a copy replaces: the directory and the three files, relative to the package. */
export declare const SHIPPED: readonly ["docs", "UPGRADING.md", "SECURITY.md", "CONTRIBUTING.md"];
/** Every file of the documentation as the package carries it — path relative to the package → bytes. */
export declare function expectedDocs(root: string): Promise<Map<string, Buffer>>;
/** Replaces the copies in `target` (the `marmeon` package) with the documentation of `root`. */
export declare function shipDocs(root: string, target: string): Promise<string[]>;
/** `docs/index.json` (format 1) of `definition` over `files` (path relative to the package → bytes): every listed page has to be among them. */
export declare function docsIndex(definition: DocsDefinition, files: ReadonlyMap<string, Buffer>, version: string): {
    format: 1;
    version: string;
    sections: Sections;
};
/** The first `#` heading outside a code fence. */
export declare function titleOf(text: string, fallback: string): string;
type Sections = {
    title: string;
    pages: {
        slug: string;
        label: string;
        title: string;
        file: string;
    }[];
}[];
export {};
//# sourceMappingURL=docs-ship.d.ts.map