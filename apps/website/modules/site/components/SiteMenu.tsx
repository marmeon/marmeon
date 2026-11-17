import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { MenuIcon, MenuItem, MenuPanel } from '../menu.ts';

/** The design's glyphs, 24 × 24 strokes. */
const GLYPHS: Record<MenuIcon, string> = {
  why: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z',
  rules: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  battery: 'M7 7h10v13H7zM10 3h4v4h-4zM10 12h4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  flask: 'M9 3h6M10 3v6l-5 10h14l-5-10V3',
  island: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7v5l3 2',
  code: 'M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14',
  agent: 'M5 8h14v11H5zM9 13h.01M15 13h.01M12 4v4',
  pkg: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  plus: 'M12 5v14M5 12h14',
  wrench: 'M15 4a5 5 0 0 0-6 6l-6 6 3 3 6-6a5 5 0 0 0 6-6l-3 3-3-3z',
  doc: 'M6 3h9l4 4v14H6zM15 3v4h4',
  term: 'M4 17l6-6-6-6M12 19h8',
  chat: 'M4 5h16v11H9l-5 4z',
  tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
};

function Glyph({ icon }: { icon: MenuIcon }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={GLYPHS[icon]} />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** A target inside the site goes through the router; one that leaves it opens with `rel="noopener"`. */
function Target({ item, className, children }: { item: MenuItem; className: string; children: ReactNode }) {
  return item.external ? (
    <a href={item.href} rel="noopener" className={className}>
      {children}
    </a>
  ) : (
    <Link href={item.href} className={className}>
      {children}
    </Link>
  );
}

/**
 * The desktop's mega menu: one `<details>` per panel, so a click opens it without JavaScript. They share a `name`, so opening one
 * closes the others; with JavaScript the header also closes the open one on Escape and returns the focus to its summary.
 */
export function SiteMenuPanels({ panels }: { panels: readonly MenuPanel[] }) {
  return (
    <>
      {panels.map((panel) => (
        <details key={panel.id} className="site-panel" name="site-panel">
          <summary>
            {panel.label}
            <Chevron />
          </summary>
          <div className="site-panel-body">
            <div className="site-panel-columns">
              {panel.columns.map((column) => (
                <div key={column.title} className="site-panel-column">
                  <p className="site-panel-title">{column.title}</p>
                  {column.items.map((item) => (
                    <Target key={item.title} item={item} className="site-panel-item">
                      <span className="site-panel-icon">
                        <Glyph icon={item.icon} />
                      </span>
                      <span>
                        <span className="site-panel-item-title">{item.title}</span>
                        <span className="site-panel-item-text">{item.text}</span>
                      </span>
                    </Target>
                  ))}
                </div>
              ))}
            </div>
            <aside className="site-panel-feature">
              <p className="site-panel-eyebrow">{panel.feature.eyebrow}</p>
              <p className="site-panel-feature-title">{panel.feature.title}</p>
              <p className="site-panel-feature-text">{panel.feature.text}</p>
              {panel.feature.lines && (
                <div className="site-panel-lines">
                  {panel.feature.lines.map((line) => (
                    <div key={line}>
                      <span aria-hidden="true">$</span> {line}
                    </div>
                  ))}
                </div>
              )}
              <Link href={panel.feature.link.href} className="site-panel-link">
                {panel.feature.link.text} →
              </Link>
            </aside>
          </div>
        </details>
      ))}
    </>
  );
}

/** The same targets for a narrow screen, inside its `<details>` menu: a title and the links of each panel. */
export function SiteMenuGroups({ panels }: { panels: readonly MenuPanel[] }) {
  return (
    <>
      {panels.map((panel) => {
        const shown = new Set<string>(); // within a group only: a page that two columns of one panel name shows once
        return (
          <div key={panel.id} className="site-menu-group">
            <p className="site-menu-title">{panel.label}</p>
            {panel.columns
              .flatMap((column) => column.items)
              .filter((item) => !shown.has(item.href) && shown.add(item.href))
              .map((item) => (
                <Target key={item.title} item={item} className="site-menu-link">
                  {item.title}
                </Target>
              ))}
          </div>
        );
      })}
    </>
  );
}
