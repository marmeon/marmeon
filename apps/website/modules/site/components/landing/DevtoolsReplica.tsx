import { DEVTOOLS_BAR_TABS, DEVTOOLS_PAGES, type SampleBarBlock } from '../../devtools-sample.ts';
import { Mark } from '../Mark.tsx';
import { type TabItem, Tabs } from '../Tabs.tsx';

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The colour class of a cell, as the real lists colour a status, a level or a state. */
function tone(column: string, value: string): string | undefined {
  if (column === 'Status' && /^\d{3}$/.test(value)) return value >= '500' ? 'is-bad' : value >= '400' ? 'is-warn' : value >= '300' ? 'is-accent' : 'is-ok';
  if (column === 'Status' || column === 'State') return /^(failed|rolled back)$/.test(value) ? 'is-bad' : /^(released|shown)$/.test(value) ? 'is-warn' : value ? 'is-ok' : undefined;
  if (column === 'Level') return value === 'error' ? 'is-bad' : value === 'warn' ? 'is-warn' : undefined;
  return undefined;
}

function Table({ columns, rows, label }: { readonly columns?: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly label: string }) {
  // The bar's Server sections are lines without columns.
  if (!columns) {
    return (
      <ul className="devtools-replica-lines" aria-label={label}>
        {rows.map((cells, index) => (
          <li key={index}>{cells.join(' ')}</li>
        ))}
      </ul>
    );
  }
  // Focusable, so a keyboard can scroll a table wider than its column.
  return (
    <div className="devtools-replica-scroll" tabIndex={0} role="region" aria-label={label}>
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, index) => (
            <tr key={index}>
              {cells.map((cell, at) => (
                <td key={at} className={tone(columns[at] ?? '', cell)}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarBlock({ block, tab }: { readonly block: SampleBarBlock; readonly tab: string }) {
  return (
    <div className="devtools-replica-block">
      {block.heading ? <p className="devtools-replica-heading">{block.heading}</p> : null}
      {block.note ? <p className="devtools-replica-note">{block.note}</p> : null}
      {block.rows ? <Table columns={block.columns} rows={block.rows.map((row) => row.cells)} label={`${tab}${block.heading ? `: ${block.heading}` : ''}`} /> : null}
    </div>
  );
}

const pages: TabItem[] = DEVTOOLS_PAGES.map((page) => ({ id: slug(page.name), label: page.name, content: <Table columns={page.columns} rows={page.rows} label={page.name} /> }));
const barTabs: TabItem[] = DEVTOOLS_BAR_TABS.map((tab) => ({
  id: slug(tab.name),
  label: tab.name,
  content: (
    <>
      {tab.blocks.map((block, index) => (
        <BarBlock key={index} block={block} tab={tab.name} />
      ))}
    </>
  ),
}));

/**
 * A copy of the devtools with invented data: the page at `/_marmeon/devtools` and the in-page bar, each with its tabs. Names
 * and columns come from the real ones (`devtools-sample.test.ts`). Without JavaScript every tab stands under its heading.
 * See docs/devtools.md#the-bar-on-every-page.
 */
export function DevtoolsReplica() {
  return (
    <figure className="devtools-replica" aria-label="Devtools, illustration with sample data">
      <div className="devtools-replica-window">
        <div className="devtools-replica-chrome">
          <Mark size={16} />
          <h3 className="devtools-replica-title">Devtools · localhost:3000</h3>
          <span className="devtools-replica-env">DEVELOPMENT</span>
        </div>
        <Tabs label="Devtools pages" idPrefix="devtools-pages" orientation="vertical" headingLevel={4} items={pages} itemClassName="devtools-replica-page" className="devtools-replica-tabs" />
      </div>
      <div className="devtools-replica-bar">
        <h3 className="devtools-replica-pill">
          <Mark size={16} />
          <span>Marmeon devtools bar</span>
        </h3>
        <Tabs label="Devtools bar" idPrefix="devtools-bar" headingLevel={4} items={barTabs} itemClassName="devtools-replica-page" className="devtools-replica-tabs" />
      </div>
    </figure>
  );
}
