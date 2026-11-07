import { mjml, MjmlError, raw, type Mjml } from '@marmeon/mail';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkedProps } from './mail/checks.ts';
import { implementation } from './mail/implementation.ts';
import type {
  MjmlDocumentProps,
  MjmlAllProps,
  MjmlClassProps,
  MjmlHtmlAttributeProps,
  MjmlSelectorProps,
  MjmlBodyProps,
  MjmlHeadProps,
  MjmlAttributesProps,
  MjmlBreakpointProps,
  MjmlHtmlAttributesProps,
  MjmlFontProps,
  MjmlPreviewProps,
  MjmlStyleProps,
  MjmlTitleProps,
  MjmlHeroProps,
  MjmlButtonProps,
  MjmlColumnProps,
  MjmlDividerProps,
  MjmlGroupProps,
  MjmlImageProps,
  MjmlRawProps,
  MjmlSectionProps,
  MjmlSpacerProps,
  MjmlTextProps,
  MjmlTableProps,
  MjmlWrapperProps,
  MjmlSocialProps,
  MjmlSocialElementProps,
  MjmlNavbarProps,
  MjmlNavbarLinkProps,
  MjmlAccordionProps,
  MjmlAccordionElementProps,
  MjmlAccordionTextProps,
  MjmlAccordionTitleProps,
  MjmlCarouselProps,
  MjmlCarouselImageProps,
} from './mail/props.ts';

export type {
  MjmlDocumentProps,
  MjmlAllProps,
  MjmlClassProps,
  MjmlHtmlAttributeProps,
  MjmlSelectorProps,
  MjmlBodyProps,
  MjmlHeadProps,
  MjmlAttributesProps,
  MjmlBreakpointProps,
  MjmlHtmlAttributesProps,
  MjmlFontProps,
  MjmlPreviewProps,
  MjmlStyleProps,
  MjmlTitleProps,
  MjmlHeroProps,
  MjmlButtonProps,
  MjmlColumnProps,
  MjmlDividerProps,
  MjmlGroupProps,
  MjmlImageProps,
  MjmlRawProps,
  MjmlSectionProps,
  MjmlSpacerProps,
  MjmlTextProps,
  MjmlTableProps,
  MjmlWrapperProps,
  MjmlSocialProps,
  MjmlSocialElementProps,
  MjmlNavbarProps,
  MjmlNavbarLinkProps,
  MjmlAccordionProps,
  MjmlAccordionElementProps,
  MjmlAccordionTextProps,
  MjmlAccordionTitleProps,
  MjmlCarouselProps,
  MjmlCarouselImageProps,
} from './mail/props.ts';

/** The MJML tag `<mjml>`, the root of a mail (`Mjml` is the class of `@marmeon/mail`). See `docs/mail.md#mail-views-in-react`. */
export function MjmlDocument(props: MjmlDocumentProps): ReactElement {
  return createElement(implementation.MjmlDocument, checkedProps('MjmlDocument', props));
}

/** The MJML tag `<mj-all>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAll(props: MjmlAllProps): ReactElement {
  return createElement(implementation.MjmlAll, checkedProps('MjmlAll', props));
}

/** The MJML tag `<mj-class>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlClass(props: MjmlClassProps): ReactElement {
  return createElement(implementation.MjmlClass, checkedProps('MjmlClass', props));
}

/** The MJML tag `<mj-html-attribute>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlHtmlAttribute(props: MjmlHtmlAttributeProps): ReactElement {
  return createElement(implementation.MjmlHtmlAttribute, checkedProps('MjmlHtmlAttribute', props));
}

/** The MJML tag `<mj-selector>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlSelector(props: MjmlSelectorProps): ReactElement {
  return createElement(implementation.MjmlSelector, checkedProps('MjmlSelector', props));
}

/** The MJML tag `<mj-body>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlBody(props: MjmlBodyProps): ReactElement {
  return createElement(implementation.MjmlBody, checkedProps('MjmlBody', props));
}

/** The MJML tag `<mj-head>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlHead(props: MjmlHeadProps): ReactElement {
  return createElement(implementation.MjmlHead, checkedProps('MjmlHead', props));
}

/** The MJML tag `<mj-attributes>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAttributes(props: MjmlAttributesProps): ReactElement {
  return createElement(implementation.MjmlAttributes, checkedProps('MjmlAttributes', props));
}

/** The MJML tag `<mj-breakpoint>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlBreakpoint(props: MjmlBreakpointProps): ReactElement {
  return createElement(implementation.MjmlBreakpoint, checkedProps('MjmlBreakpoint', props));
}

/** The MJML tag `<mj-html-attributes>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlHtmlAttributes(props: MjmlHtmlAttributesProps): ReactElement {
  return createElement(implementation.MjmlHtmlAttributes, checkedProps('MjmlHtmlAttributes', props));
}

/** The MJML tag `<mj-font>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlFont(props: MjmlFontProps): ReactElement {
  return createElement(implementation.MjmlFont, checkedProps('MjmlFont', props));
}

/** The MJML tag `<mj-preview>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlPreview(props: MjmlPreviewProps): ReactElement {
  return createElement(implementation.MjmlPreview, checkedProps('MjmlPreview', props));
}

/** The MJML tag `<mj-style>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlStyle(props: MjmlStyleProps): ReactElement {
  return createElement(implementation.MjmlStyle, checkedProps('MjmlStyle', props));
}

/** The MJML tag `<mj-title>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlTitle(props: MjmlTitleProps): ReactElement {
  return createElement(implementation.MjmlTitle, checkedProps('MjmlTitle', props));
}

/** The MJML tag `<mj-hero>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlHero(props: MjmlHeroProps): ReactElement {
  return createElement(implementation.MjmlHero, checkedProps('MjmlHero', props));
}

/** The MJML tag `<mj-button>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlButton(props: MjmlButtonProps): ReactElement {
  return createElement(implementation.MjmlButton, checkedProps('MjmlButton', props));
}

/** The MJML tag `<mj-column>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlColumn(props: MjmlColumnProps): ReactElement {
  return createElement(implementation.MjmlColumn, checkedProps('MjmlColumn', props));
}

/** The MJML tag `<mj-divider>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlDivider(props: MjmlDividerProps): ReactElement {
  return createElement(implementation.MjmlDivider, checkedProps('MjmlDivider', props));
}

/** The MJML tag `<mj-group>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlGroup(props: MjmlGroupProps): ReactElement {
  return createElement(implementation.MjmlGroup, checkedProps('MjmlGroup', props));
}

/** The MJML tag `<mj-image>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlImage(props: MjmlImageProps): ReactElement {
  return createElement(implementation.MjmlImage, checkedProps('MjmlImage', props));
}

/** The MJML tag `<mj-raw>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlRaw(props: MjmlRawProps): ReactElement {
  return createElement(implementation.MjmlRaw, checkedProps('MjmlRaw', props));
}

/** The MJML tag `<mj-section>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlSection(props: MjmlSectionProps): ReactElement {
  return createElement(implementation.MjmlSection, checkedProps('MjmlSection', props));
}

/** The MJML tag `<mj-spacer>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlSpacer(props: MjmlSpacerProps): ReactElement {
  return createElement(implementation.MjmlSpacer, checkedProps('MjmlSpacer', props));
}

/** The MJML tag `<mj-text>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlText(props: MjmlTextProps): ReactElement {
  return createElement(implementation.MjmlText, checkedProps('MjmlText', props));
}

/** The MJML tag `<mj-table>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlTable(props: MjmlTableProps): ReactElement {
  return createElement(implementation.MjmlTable, checkedProps('MjmlTable', props));
}

/** The MJML tag `<mj-wrapper>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlWrapper(props: MjmlWrapperProps): ReactElement {
  return createElement(implementation.MjmlWrapper, checkedProps('MjmlWrapper', props));
}

/** The MJML tag `<mj-social>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlSocial(props: MjmlSocialProps): ReactElement {
  return createElement(implementation.MjmlSocial, checkedProps('MjmlSocial', props));
}

/** The MJML tag `<mj-social-element>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlSocialElement(props: MjmlSocialElementProps): ReactElement {
  return createElement(implementation.MjmlSocialElement, checkedProps('MjmlSocialElement', props));
}

/** The MJML tag `<mj-navbar>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlNavbar(props: MjmlNavbarProps): ReactElement {
  return createElement(implementation.MjmlNavbar, checkedProps('MjmlNavbar', props));
}

/** The MJML tag `<mj-navbar-link>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlNavbarLink(props: MjmlNavbarLinkProps): ReactElement {
  return createElement(implementation.MjmlNavbarLink, checkedProps('MjmlNavbarLink', props));
}

/** The MJML tag `<mj-accordion>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAccordion(props: MjmlAccordionProps): ReactElement {
  return createElement(implementation.MjmlAccordion, checkedProps('MjmlAccordion', props));
}

/** The MJML tag `<mj-accordion-element>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAccordionElement(props: MjmlAccordionElementProps): ReactElement {
  return createElement(implementation.MjmlAccordionElement, checkedProps('MjmlAccordionElement', props));
}

/** The MJML tag `<mj-accordion-text>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAccordionText(props: MjmlAccordionTextProps): ReactElement {
  return createElement(implementation.MjmlAccordionText, checkedProps('MjmlAccordionText', props));
}

/** The MJML tag `<mj-accordion-title>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlAccordionTitle(props: MjmlAccordionTitleProps): ReactElement {
  return createElement(implementation.MjmlAccordionTitle, checkedProps('MjmlAccordionTitle', props));
}

/** The MJML tag `<mj-carousel>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlCarousel(props: MjmlCarouselProps): ReactElement {
  return createElement(implementation.MjmlCarousel, checkedProps('MjmlCarousel', props));
}

/** The MJML tag `<mj-carousel-image>`. See `docs/mail.md#mail-views-in-react`. */
export function MjmlCarouselImage(props: MjmlCarouselImageProps): ReactElement {
  return createElement(implementation.MjmlCarouselImage, checkedProps('MjmlCarouselImage', props));
}

/** What a view's markup must start with: the root or, for a fragment (the body of a layout), a tag of MJML. */
const MJML_START = /^\s*<(?:mjml[\s>/]|mj-)/;
const MJML_ROOT = /<mjml[\s>/]/;
const MJML_ROOT_FIRST = /^\s*<mjml[\s>/]/;

/**
 * Renders a view — a component of `@marmeon/react/mail` or its element — to a `Mjml`, which compiles, validates strictly and
 * is checked for third-party images (`docs/mail.md#writing-mails`) when the mail is sent, like a `mjml` template. Pass the
 * view and its props, not a call of it (`toMjml(View, props)`): a view with hooks runs inside the renderer only that way.
 * See `docs/mail.md#mail-views-in-react`.
 *
 * @throws MjmlError when React moved a `<title>`, `<meta>` or `<link>` out of the mail, something comes before the root, or the view renders no MJML.
 */
export function toMjml<P extends object>(view: (props: P) => ReactNode, props: P): Mjml;
export function toMjml(element: ReactElement): Mjml;
export function toMjml(view: ReactElement | ((props: never) => ReactNode), props?: object): Mjml {
  const element = isValidElement(view) ? view : createElement(view as (props: object) => ReactNode, props);
  const markup = renderToStaticMarkup(element);
  // A root, when there is one, must come first: anything in front of it (a sibling in a fragment) is dropped by mjml without a word.
  if (!MJML_START.test(markup) || (!MJML_ROOT_FIRST.test(markup) && MJML_ROOT.test(markup))) {
    throw new MjmlError(
      `The view rendered ${JSON.stringify(markup.trimStart().slice(0, 40))} where MJML was expected. React moves a JSX <title>, <meta> or <link> out of the mail, also from inside MjmlRaw, in front of the root where mjml drops it, and it adds a <link> to preload a JSX <img>. Use MjmlTitle for the title, <MjmlRaw dangerouslySetInnerHTML={{ __html: '<meta …>' }} /> for a <meta> or <link>, and MjmlImage for an image. A view renders <MjmlDocument> first or, as a layout's body, the tags inside <mj-body>.`,
    );
  }
  // `raw()` is sound here: React wrote every text and attribute value escaped, with the characters `html` escapes. The two ways to
  // raw output are MjmlRaw's dangerouslySetInnerHTML and the string child of MjmlStyle — as with `raw()`, markup and CSS you wrote,
  // never data; every other component refuses them (checkedProps). What compiles is still a `Mjml`: strict validation, the
  // checks for images of other hosts and `checkLinks` run on it like on a template.
  return mjml`${raw(markup)}`;
}
