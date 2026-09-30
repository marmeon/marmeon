import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { useRouter } from './app.tsx';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  replace?: boolean;
}

/** An `<a>` that navigates client-side for same-origin, plain left clicks — and degrades to a normal link. */
export function Link({ href, replace, onClick, ...rest }: LinkProps) {
  const { visit } = useRouter();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== '_self') return;

    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    void visit(url.pathname + url.search + url.hash, { replace });
  };

  return <a href={href} onClick={handleClick} {...rest} />;
}
