/** The Markdown table of `pnpm size`: what each scenario and app downloads, in KB gzip, with the base commit's size beside it. */

/** KB gzip of the initial download by scenario or app name; `undefined` where the base could not build or does not have it. */
export type Sizes = Readonly<Record<string, number>>;

const kbText = (value: number | undefined) => (value === undefined ? 'n/a' : value.toFixed(2));

function deltaText(base: number | undefined, size: number | undefined): [string, string] {
  if (base === undefined || size === undefined) return ['', ''];
  const delta = Math.round((size - base) * 100) / 100;
  const sign = delta > 0 ? '+' : '';
  const percent = base === 0 ? '' : `${sign}${(((size - base) / base) * 100).toFixed(1)} %`;
  return [`${sign}${delta.toFixed(2)}`, percent];
}

/** A table of `size` (and `base` when given), one row per name in `size`, in its order. Never judges a size. */
export function renderSizeTable(size: Sizes, base?: Sizes): string {
  const lines = base
    ? ['| Scenario | Base | PR | Delta (KB) | Delta (%) |', '| --- | ---: | ---: | ---: | ---: |']
    : ['| Scenario | KB gzip |', '| --- | ---: |'];
  // Rows the pull request removed stay, with PR = n/a.
  const names = base ? [...Object.keys(size), ...Object.keys(base).filter((name) => !(name in size))] : Object.keys(size);
  for (const name of names) {
    const value = size[name];
    if (!base) {
      lines.push(`| ${name} | ${kbText(value)} |`);
      continue;
    }
    const [delta, percent] = deltaText(base[name], value);
    lines.push(`| ${name} | ${kbText(base[name])} | ${kbText(value)} | ${delta} | ${percent} |`);
  }
  return lines.join('\n');
}
