import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent } from 'react';
import { useRouter, type VisitMethod, type VisitOptions } from './app.tsx';

interface LinkOptions {
  href: string;
  replace?: boolean;
  preserveScroll?: boolean;
}

type AnchorLinkProps = LinkOptions & AnchorHTMLAttributes<HTMLAnchorElement> & { method?: 'get' };

type ActionLinkProps = LinkOptions &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
    /** Other methods render a `<button>` — actions are not links (logout, delete). */
    method: Exclude<VisitMethod, 'get'>;
    data?: VisitOptions['data'];
  };

export type LinkProps = AnchorLinkProps | ActionLinkProps;

function isAction(props: LinkProps): props is ActionLinkProps {
  return props.method !== undefined && props.method !== 'get';
}

/**
 * An `<a>` that navigates client-side for same-origin, plain left clicks — and
 * degrades to a normal link. With `method="post"` (or put/patch/delete) it is a
 * button that sends a visit with the CSRF token: `<Link method="post" href="/logout">`.
 */
export function Link(props: LinkProps) {
  const { visit } = useRouter();

  if (isAction(props)) {
    const { href, method, data, replace, preserveScroll, onClick, ...rest } = props;
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      void visit(href, { method, data, replace, preserveScroll });
    };
    return <button type="button" onClick={handleClick} {...rest} />;
  }

  const { href, replace, preserveScroll, onClick, method: _method, ...rest } = props as AnchorLinkProps;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== '_self') return;

    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    void visit(url.pathname + url.search + url.hash, { replace, preserveScroll });
  };

  return <a href={href} onClick={handleClick} {...rest} />;
}
