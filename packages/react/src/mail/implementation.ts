import * as Impl from '@faire/mjml-react';
import type { ComponentType } from 'react';
import type { MjmlComponentName } from './props.ts';

// The components `@marmeon/react/mail` renders — the one place that imports `@faire/mjml-react`, an exact dependency of this
// package. Replacing the library (a fork, another package) changes this file, the compatibility tests and nothing else: the
// names, props and checks of the components are Marmeon's own, and no name or type of the library is public (`pnpm api:check`
// refuses one). A line comment, not JSDoc: JSDoc would carry the library's name into the `.d.ts`. `any` props: the wrappers
// check and type them before they get here.
export const implementation: Readonly<Record<MjmlComponentName, ComponentType<any>>> = {
  MjmlDocument: Impl.Mjml,
  MjmlAll: Impl.MjmlAll,
  MjmlClass: Impl.MjmlClass,
  MjmlHtmlAttribute: Impl.MjmlHtmlAttribute,
  MjmlSelector: Impl.MjmlSelector,
  MjmlBody: Impl.MjmlBody,
  MjmlHead: Impl.MjmlHead,
  MjmlAttributes: Impl.MjmlAttributes,
  MjmlBreakpoint: Impl.MjmlBreakpoint,
  MjmlHtmlAttributes: Impl.MjmlHtmlAttributes,
  MjmlFont: Impl.MjmlFont,
  MjmlPreview: Impl.MjmlPreview,
  MjmlStyle: Impl.MjmlStyle,
  MjmlTitle: Impl.MjmlTitle,
  MjmlHero: Impl.MjmlHero,
  MjmlButton: Impl.MjmlButton,
  MjmlColumn: Impl.MjmlColumn,
  MjmlDivider: Impl.MjmlDivider,
  MjmlGroup: Impl.MjmlGroup,
  MjmlImage: Impl.MjmlImage,
  MjmlRaw: Impl.MjmlRaw,
  MjmlSection: Impl.MjmlSection,
  MjmlSpacer: Impl.MjmlSpacer,
  MjmlText: Impl.MjmlText,
  MjmlTable: Impl.MjmlTable,
  MjmlWrapper: Impl.MjmlWrapper,
  MjmlSocial: Impl.MjmlSocial,
  MjmlSocialElement: Impl.MjmlSocialElement,
  MjmlNavbar: Impl.MjmlNavbar,
  MjmlNavbarLink: Impl.MjmlNavbarLink,
  MjmlAccordion: Impl.MjmlAccordion,
  MjmlAccordionElement: Impl.MjmlAccordionElement,
  MjmlAccordionText: Impl.MjmlAccordionText,
  MjmlAccordionTitle: Impl.MjmlAccordionTitle,
  MjmlCarousel: Impl.MjmlCarousel,
  MjmlCarouselImage: Impl.MjmlCarouselImage,
};
