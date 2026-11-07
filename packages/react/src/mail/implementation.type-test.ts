// What the components of `@marmeon/react/mail` must keep from the library they are built on — checked by `tsc`, never run. With
// `scripts/mail-implementation.test.ts` this is the compatibility test of a replacement: a new version of the library, a fork or
// another package passes it or the difference is decided here.
//
// Both ways, per component: every prop of ours is one the library knows, with a value it accepts; every prop of the library is
// one of ours, with the narrowings below as the only exceptions (`Narrowed`: a value we take narrower; `Omitted`: a prop we leave out). A version that adds or removes a prop turns this red until
// someone decides: take it into `props.ts`, or leave it out and say so.
import type * as Impl from '@faire/mjml-react';
import type * as Ours from './props.ts';

/** What a component narrows on purpose: `className` (it is `cssClass`), a raw `dangerouslySetInnerHTML` (only `MjmlRaw`), `lineHeight` as a number (it would be px). */
type Always = 'className' | 'dangerouslySetInnerHTML' | 'lineHeight';

/** Props whose value the library types as a CSS length or keyword that may also be a number: ours take a string, the number is dropped there (`borderRadius` and `backgroundSize` take it, as px). */
type Narrowed = 'border' | 'backgroundPosition' | 'textDecoration';

/** The props of the library a component leaves out, per component; `MjmlStyle` also takes its child as a string only. */
interface Omitted {
  MjmlDocument: Always;
  MjmlAll: Always;
  MjmlClass: Always;
  MjmlHtmlAttribute: Always;
  MjmlSelector: Always;
  MjmlBody: Always;
  MjmlHead: Always;
  MjmlAttributes: Always;
  MjmlBreakpoint: Always;
  MjmlHtmlAttributes: Always;
  MjmlFont: Always;
  MjmlPreview: Always;
  MjmlStyle: 'className' | 'dangerouslySetInnerHTML' | 'children';
  MjmlTitle: Always;
  MjmlHero: Always;
  MjmlButton: Always;
  MjmlColumn: Always;
  MjmlDivider: Always;
  MjmlGroup: Always;
  MjmlImage: Always;
  MjmlRaw: 'className';
  MjmlSection: Always;
  MjmlSpacer: Always;
  MjmlText: Always;
  MjmlTable: Always;
  MjmlWrapper: Always;
  MjmlSocial: Always;
  MjmlSocialElement: Always;
  MjmlNavbar: Always;
  MjmlNavbarLink: Always;
  MjmlAccordion: Always;
  MjmlAccordionElement: Always;
  MjmlAccordionText: Always;
  MjmlAccordionTitle: Always;
  MjmlCarousel: Always;
  MjmlCarouselImage: Always;
}

type Assert<T extends true> = T;

/** `O` (ours) takes nothing the library does not know, and the library's props but the omitted ones are all ours, with values we take. */
type Compatible<O, I, Options extends { omitted: PropertyKey }> = [Exclude<keyof O, keyof I>] extends [never]
  ? [Exclude<keyof Omit<I, Options['omitted']>, keyof O>] extends [never]
    ? [O] extends [I]
      ? [Omit<I, Options['omitted'] | Narrowed>] extends [O]
        ? true
        : false
      : false
    : false
  : false;

export type Compatibility = [
  Assert<Compatible<Ours.MjmlDocumentProps, Impl.IMjmlProps, { omitted: Omitted['MjmlDocument'] }>>,
  Assert<Compatible<Ours.MjmlAllProps, Impl.IMjmlAllProps, { omitted: Omitted['MjmlAll'] }>>,
  Assert<Compatible<Ours.MjmlClassProps, Impl.IMjmlClassProps, { omitted: Omitted['MjmlClass'] }>>,
  Assert<Compatible<Ours.MjmlHtmlAttributeProps, Impl.IMjmlHtmlAttributeProps, { omitted: Omitted['MjmlHtmlAttribute'] }>>,
  Assert<Compatible<Ours.MjmlSelectorProps, Impl.IMjmlSelectorProps, { omitted: Omitted['MjmlSelector'] }>>,
  Assert<Compatible<Ours.MjmlBodyProps, Impl.IMjmlBodyProps, { omitted: Omitted['MjmlBody'] }>>,
  Assert<Compatible<Ours.MjmlHeadProps, Impl.IMjmlHeadProps, { omitted: Omitted['MjmlHead'] }>>,
  Assert<Compatible<Ours.MjmlAttributesProps, Impl.IMjmlAttributesProps, { omitted: Omitted['MjmlAttributes'] }>>,
  Assert<Compatible<Ours.MjmlBreakpointProps, Impl.IMjmlBreakpointProps, { omitted: Omitted['MjmlBreakpoint'] }>>,
  Assert<Compatible<Ours.MjmlHtmlAttributesProps, Impl.IMjmlHtmlAttributesProps, { omitted: Omitted['MjmlHtmlAttributes'] }>>,
  Assert<Compatible<Ours.MjmlFontProps, Impl.IMjmlFontProps, { omitted: Omitted['MjmlFont'] }>>,
  Assert<Compatible<Ours.MjmlPreviewProps, Impl.IMjmlPreviewProps, { omitted: Omitted['MjmlPreview'] }>>,
  Assert<Compatible<Ours.MjmlStyleProps, Impl.IMjmlStyleProps, { omitted: Omitted['MjmlStyle'] }>>,
  Assert<Compatible<Ours.MjmlTitleProps, Impl.IMjmlTitleProps, { omitted: Omitted['MjmlTitle'] }>>,
  Assert<Compatible<Ours.MjmlHeroProps, Impl.IMjmlHeroProps, { omitted: Omitted['MjmlHero'] }>>,
  Assert<Compatible<Ours.MjmlButtonProps, Impl.IMjmlButtonProps, { omitted: Omitted['MjmlButton'] }>>,
  Assert<Compatible<Ours.MjmlColumnProps, Impl.IMjmlColumnProps, { omitted: Omitted['MjmlColumn'] }>>,
  Assert<Compatible<Ours.MjmlDividerProps, Impl.IMjmlDividerProps, { omitted: Omitted['MjmlDivider'] }>>,
  Assert<Compatible<Ours.MjmlGroupProps, Impl.IMjmlGroupProps, { omitted: Omitted['MjmlGroup'] }>>,
  Assert<Compatible<Ours.MjmlImageProps, Impl.IMjmlImageProps, { omitted: Omitted['MjmlImage'] }>>,
  Assert<Compatible<Ours.MjmlRawProps, Impl.IMjmlRawProps, { omitted: Omitted['MjmlRaw'] }>>,
  Assert<Compatible<Ours.MjmlSectionProps, Impl.IMjmlSectionProps, { omitted: Omitted['MjmlSection'] }>>,
  Assert<Compatible<Ours.MjmlSpacerProps, Impl.IMjmlSpacerProps, { omitted: Omitted['MjmlSpacer'] }>>,
  Assert<Compatible<Ours.MjmlTextProps, Impl.IMjmlTextProps, { omitted: Omitted['MjmlText'] }>>,
  Assert<Compatible<Ours.MjmlTableProps, Impl.IMjmlTableProps, { omitted: Omitted['MjmlTable'] }>>,
  Assert<Compatible<Ours.MjmlWrapperProps, Impl.IMjmlWrapperProps, { omitted: Omitted['MjmlWrapper'] }>>,
  Assert<Compatible<Ours.MjmlSocialProps, Impl.IMjmlSocialProps, { omitted: Omitted['MjmlSocial'] }>>,
  Assert<Compatible<Ours.MjmlSocialElementProps, Impl.IMjmlSocialElementProps, { omitted: Omitted['MjmlSocialElement'] }>>,
  Assert<Compatible<Ours.MjmlNavbarProps, Impl.IMjmlNavbarProps, { omitted: Omitted['MjmlNavbar'] }>>,
  Assert<Compatible<Ours.MjmlNavbarLinkProps, Impl.IMjmlNavbarLinkProps, { omitted: Omitted['MjmlNavbarLink'] }>>,
  Assert<Compatible<Ours.MjmlAccordionProps, Impl.IMjmlAccordionProps, { omitted: Omitted['MjmlAccordion'] }>>,
  Assert<Compatible<Ours.MjmlAccordionElementProps, Impl.IMjmlAccordionElementProps, { omitted: Omitted['MjmlAccordionElement'] }>>,
  Assert<Compatible<Ours.MjmlAccordionTextProps, Impl.IMjmlAccordionTextProps, { omitted: Omitted['MjmlAccordionText'] }>>,
  Assert<Compatible<Ours.MjmlAccordionTitleProps, Impl.IMjmlAccordionTitleProps, { omitted: Omitted['MjmlAccordionTitle'] }>>,
  Assert<Compatible<Ours.MjmlCarouselProps, Impl.IMjmlCarouselProps, { omitted: Omitted['MjmlCarousel'] }>>,
  Assert<Compatible<Ours.MjmlCarouselImageProps, Impl.IMjmlCarouselImageProps, { omitted: Omitted['MjmlCarouselImage'] }>>,
];
