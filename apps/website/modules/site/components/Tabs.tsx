import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { useHydrated } from './useHydrated.ts';

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

export interface TabsProps {
  /** The tablist's accessible name. */
  readonly label: string;
  readonly items: readonly TabItem[];
  /** Prefix of the element ids, unique on the page (`batteries`): ids come from it and `item.id`, so server and client agree. */
  readonly idPrefix: string;
  readonly orientation?: 'horizontal' | 'vertical';
  /** The container of the stacked entries without JavaScript. */
  readonly stackAs?: 'div' | 'ol';
  /** Class of each stacked entry (`<li>` for `ol`, else `<section>`). */
  readonly itemClassName?: string;
  readonly headingLevel?: 3 | 4;
  readonly className?: string;
}

/**
 * Tabs as progressive enhancement: the server's HTML stacks every item under its heading, so nothing depends on JavaScript. After hydration
 * the same items become an ARIA tablist (automatic activation, arrow keys by orientation, `Home` and `End`).
 */
export function Tabs({ label, items, idPrefix, orientation = 'horizontal', stackAs = 'div', itemClassName, headingLevel = 3, className }: TabsProps) {
  const hydrated = useHydrated();
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const Heading = `h${headingLevel}` as const;
  const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

  if (!hydrated) {
    const Stack = stackAs;
    const Entry = stackAs === 'ol' ? 'li' : 'section';
    return (
      <Stack className={classes('tabs', 'tabs--stack', className)}>
        {items.map((item) => (
          <Entry key={item.id} className={itemClassName}>
            <Heading className="tabs-heading">{item.label}</Heading>
            {item.content}
          </Entry>
        ))}
      </Stack>
    );
  }

  const select = (index: number) => {
    setSelected(index);
    tabs.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const [previous, next] = orientation === 'vertical' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const last = items.length - 1;
    const target = { [previous]: (selected + last) % items.length, [next]: (selected + 1) % items.length, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div className={classes('tabs', `tabs--${orientation}`, className)}>
      <div role="tablist" aria-label={label} aria-orientation={orientation} className="tabs-list" onKeyDown={onKeyDown}>
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={index === selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={index === selected ? 0 : -1}
            className="tabs-tab"
            onClick={() => setSelected(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item, index) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${idPrefix}-panel-${item.id}`}
          aria-labelledby={`${idPrefix}-tab-${item.id}`}
          tabIndex={0}
          hidden={index !== selected}
          className={classes('tabs-panel', itemClassName)}
        >
          <Heading className="tabs-heading visually-hidden">{item.label}</Heading>
          {item.content}
        </div>
      ))}
    </div>
  );
}
