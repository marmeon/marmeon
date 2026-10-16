import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { DeclarationReader } from './declarations.ts';

describe('the exports of a declaration file', () => {
  it('leave out what is exported as a type only — a class so has no value to inject', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'a.d.ts'), 'export declare class Real {\n    constructor(x: Other);\n}\nexport declare class Hidden {\n    constructor(x: Other);\n}\nexport declare class Mixed {}\nexport interface Other {}\n');
    writeFileSync(join(dir, 'entry.d.ts'), "export { Real } from './a.js';\nexport type { Hidden } from './a.js';\nexport { type Mixed } from './a.js';\n");
    const exports = new DeclarationReader().read(join(dir, 'entry.d.ts')).exports;
    expect([...exports.keys()].sort()).toEqual(['Real']);
  });

  it('leave out the local forms of a type-only export too', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'local.d.ts'), 'declare class Real {\n    constructor(x: Real);\n}\ndeclare class Hidden {}\ndeclare class Mixed {}\nexport { Real };\nexport type { Hidden };\nexport { type Mixed };\n');
    const exports = new DeclarationReader().read(join(dir, 'local.d.ts')).exports;
    expect([...exports.keys()].sort()).toEqual(['Real']);
  });
});
