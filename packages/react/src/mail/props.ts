import type { ReactNode } from 'react';

// The props of the components of `@marmeon/react/mail`, written out here and owned by Marmeon: the library the components are
// built on is not named in any type (the compatibility test in `implementation.type-test.ts` keeps the two in step).
// camelCase names become the kebab-case attributes of MJML; a number is `px` (`lineHeight` takes a string).

/** The props of `<MjmlDocument>`, the MJML tag `<mjml>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlDocumentProps {
  children?: ReactNode;
  owa?: string;
  lang?: string;
}

/** The props of `<MjmlAll>`, the MJML tag `<mj-all>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAllProps {
  cssClass?: string;
  mjmlClass?: string;
  [attribute: string]: string | undefined;
}

/** The props of `<MjmlClass>`, the MJML tag `<mj-class>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlClassProps {
  name?: string;
  [attribute: string]: string | undefined;
}

/** The props of `<MjmlHtmlAttribute>`, the MJML tag `<mj-html-attribute>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlHtmlAttributeProps {
  children?: ReactNode;
  name?: string;
}

/** The props of `<MjmlSelector>`, the MJML tag `<mj-selector>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlSelectorProps {
  children?: ReactNode;
  path?: string;
}

/** The props of `<MjmlBody>`, the MJML tag `<mj-body>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlBodyProps {
  /** MJML default value: 600px */
  width?: string | number;
  backgroundColor?: string;
  id?: string;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlHead>`, the MJML tag `<mj-head>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlHeadProps {
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlAttributes>`, the MJML tag `<mj-attributes>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAttributesProps {
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlBreakpoint>`, the MJML tag `<mj-breakpoint>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlBreakpointProps {
  width?: string;
}

/** The props of `<MjmlHtmlAttributes>`, the MJML tag `<mj-html-attributes>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlHtmlAttributesProps {
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlFont>`, the MJML tag `<mj-font>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlFontProps {
  name?: string;
  href?: string;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlPreview>`, the MJML tag `<mj-preview>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlPreviewProps {
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlStyle>`, the MJML tag `<mj-style>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlStyleProps {
  inline?: boolean;
  /** The CSS, as one string (a template literal): it is written as it is, like `raw()`. */
  children?: string;
}

/** The props of `<MjmlTitle>`, the MJML tag `<mj-title>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlTitleProps {
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlHero>`, the MJML tag `<mj-hero>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlHeroProps {
  /** MJML default value: fixed-height */
  mode?: string;
  /** MJML default value: 0px */
  height?: string | number;
  backgroundUrl?: string;
  backgroundWidth?: string | number;
  backgroundHeight?: string | number;
  backgroundPosition?: string;
  borderRadius?: string | number;
  innerBackgroundColor?: string;
  innerPadding?: string | number;
  innerPaddingTop?: string | number;
  innerPaddingLeft?: string | number;
  innerPaddingRight?: string | number;
  innerPaddingBottom?: string | number;
  /** MJML default value: 0px */
  padding?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  backgroundColor?: string;
  verticalAlign?: 'top' | 'bottom' | 'middle';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlButton>`, the MJML tag `<mj-button>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlButtonProps {
  /** MJML default value: center */
  align?: 'left' | 'center' | 'right';
  backgroundColor?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRadius?: string | number;
  borderRight?: string;
  borderTop?: string;
  /** MJML default value: none */
  border?: string;
  /** MJML default value: #ffffff */
  color?: string;
  containerBackgroundColor?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontStyle?: string;
  fontWeight?: string;
  height?: string | number;
  href?: string;
  name?: string;
  title?: string;
  innerPadding?: string | number;
  letterSpacing?: string | number;
  lineHeight?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  rel?: string;
  /** MJML default value: _blank */
  target?: string;
  textDecoration?: string;
  textTransform?: string;
  verticalAlign?: 'top' | 'bottom' | 'middle';
  textAlign?: 'left' | 'right' | 'center';
  width?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlColumn>`, the MJML tag `<mj-column>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlColumnProps {
  backgroundColor?: string;
  border?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRadius?: string | number;
  borderRight?: string;
  borderTop?: string;
  /** MJML default value: ltr */
  direction?: 'ltr' | 'rtl';
  innerBackgroundColor?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  innerBorder?: string;
  innerBorderBottom?: string;
  innerBorderLeft?: string;
  innerBorderRadius?: string;
  innerBorderRight?: string;
  innerBorderTop?: string;
  padding?: string | number;
  verticalAlign?: 'top' | 'bottom' | 'middle';
  width?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlDivider>`, the MJML tag `<mj-divider>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlDividerProps {
  borderColor?: string;
  borderStyle?: string;
  borderWidth?: string | number;
  containerBackgroundColor?: string;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 100% */
  width?: string | number;
  /** MJML default value: center */
  align?: 'left' | 'center' | 'right';
  cssClass?: string;
  mjmlClass?: string;
}

/** The props of `<MjmlGroup>`, the MJML tag `<mj-group>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlGroupProps {
  backgroundColor?: string;
  /** MJML default value: ltr */
  direction?: 'ltr' | 'rtl';
  verticalAlign?: 'top' | 'bottom' | 'middle';
  width?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlImage>`, the MJML tag `<mj-image>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlImageProps {
  alt?: string;
  href?: string;
  name?: string;
  src?: string;
  srcset?: string;
  sizes?: string;
  title?: string;
  rel?: string;
  /** MJML default value: center */
  align?: 'left' | 'center' | 'right';
  /** MJML default value: 0 */
  border?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  borderTop?: string;
  borderRadius?: string | number;
  containerBackgroundColor?: string;
  fluidOnMobile?: boolean;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: _blank */
  target?: string;
  width?: string | number;
  /** MJML default value: auto */
  height?: string | number;
  maxHeight?: string | number;
  fontSize?: string | number;
  usemap?: string;
  cssClass?: string;
  mjmlClass?: string;
}

/** The props of `<MjmlRaw>`, the MJML tag `<mj-raw>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlRawProps {
  position?: 'file-start';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
  /** Markup you wrote, written as it is, like `raw()` — never data. */
  dangerouslySetInnerHTML?: {
    __html: string;
  };
}

/** The props of `<MjmlSection>`, the MJML tag `<mj-section>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlSectionProps {
  backgroundColor?: string;
  backgroundUrl?: string;
  backgroundRepeat?: 'repeat' | 'no-repeat';
  backgroundSize?: string | number;
  backgroundPosition?: string;
  backgroundPositionX?: string;
  backgroundPositionY?: string;
  border?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRadius?: string | number;
  borderRight?: string;
  borderTop?: string;
  /** MJML default value: ltr */
  direction?: 'ltr' | 'rtl';
  fullWidth?: boolean;
  /** MJML default value: 20px 0 */
  padding?: string | number;
  paddingTop?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  textAlign?: 'left' | 'center' | 'right';
  textPadding?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlSpacer>`, the MJML tag `<mj-spacer>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlSpacerProps {
  border?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  borderTop?: string;
  containerBackgroundColor?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  padding?: string | number;
  /** MJML default value: 20px */
  height?: string | number;
  cssClass?: string;
  mjmlClass?: string;
}

/** The props of `<MjmlText>`, the MJML tag `<mj-text>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlTextProps {
  /** MJML default value: left */
  align?: 'left' | 'right' | 'center' | 'justify';
  backgroundColor?: string;
  /** MJML default value: #000000 */
  color?: string;
  containerBackgroundColor?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontStyle?: string;
  fontWeight?: string;
  height?: string | number;
  letterSpacing?: string | number;
  lineHeight?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  textDecoration?: string;
  textTransform?: string;
  verticalAlign?: 'top' | 'bottom' | 'middle';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlTable>`, the MJML tag `<mj-table>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlTableProps {
  /** MJML default value: left */
  align?: 'left' | 'right' | 'center';
  /** MJML default value: none */
  border?: string;
  /** MJML default value: 0 */
  cellpadding?: string;
  /** MJML default value: 0 */
  cellspacing?: string;
  containerBackgroundColor?: string;
  /** MJML default value: #000000 */
  color?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontWeight?: string;
  lineHeight?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  role?: 'none' | 'presentation';
  tableLayout?: 'auto' | 'fixed' | 'initial' | 'inherit';
  verticalAlign?: 'top' | 'bottom' | 'middle';
  /** MJML default value: 100% */
  width?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlWrapper>`, the MJML tag `<mj-wrapper>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlWrapperProps {
  backgroundColor?: string;
  backgroundUrl?: string;
  backgroundRepeat?: 'repeat' | 'no-repeat';
  backgroundSize?: string | number;
  backgroundPosition?: string;
  backgroundPositionX?: string;
  backgroundPositionY?: string;
  border?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRadius?: string | number;
  borderRight?: string;
  borderTop?: string;
  /** MJML default value: ltr */
  direction?: 'ltr' | 'rtl';
  fullWidth?: boolean;
  /** MJML default value: 20px 0 */
  padding?: string | number;
  paddingTop?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  textAlign?: 'left' | 'center' | 'right';
  textPadding?: string | number;
  gap?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlSocial>`, the MJML tag `<mj-social>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlSocialProps {
  /** MJML default value: center */
  align?: 'left' | 'right' | 'center';
  borderRadius?: string | number;
  containerBackgroundColor?: string;
  /** MJML default value: #333333 */
  color?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontStyle?: string;
  fontWeight?: string;
  iconSize?: string | number;
  iconHeight?: string | number;
  iconPadding?: string | number;
  innerPadding?: string | number;
  lineHeight?: string;
  /** MJML default value: horizontal */
  mode?: 'horizontal' | 'vertical';
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  tableLayout?: 'auto' | 'fixed';
  textPadding?: string | number;
  textDecoration?: string;
  verticalAlign?: 'top' | 'bottom' | 'middle';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlSocialElement>`, the MJML tag `<mj-social-element>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlSocialElementProps {
  /** MJML default value: left */
  align?: 'left' | 'center' | 'right';
  iconPosition?: 'left' | 'right';
  backgroundColor?: string;
  /** MJML default value: #000 */
  color?: string;
  borderRadius?: string | number;
  fontFamily?: string;
  fontSize?: string | number;
  fontStyle?: string;
  fontWeight?: string;
  href?: string;
  iconSize?: string | number;
  iconHeight?: string | number;
  iconPadding?: string | number;
  lineHeight?: string;
  name?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 4px */
  padding?: string | number;
  textPadding?: string | number;
  rel?: string;
  src?: string;
  srcset?: string;
  sizes?: string;
  alt?: string;
  title?: string;
  /** MJML default value: _blank */
  target?: string;
  textDecoration?: string;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlNavbar>`, the MJML tag `<mj-navbar>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlNavbarProps {
  /** MJML default value: center */
  align?: 'left' | 'center' | 'right';
  baseUrl?: string;
  hamburger?: string;
  icoAlign?: 'left' | 'center' | 'right';
  icoOpen?: string;
  icoClose?: string;
  icoColor?: string;
  icoFontSize?: string | number;
  icoFontFamily?: string;
  icoTextTransform?: string;
  icoPadding?: string | number;
  icoPaddingLeft?: string | number;
  icoPaddingTop?: string | number;
  icoPaddingRight?: string | number;
  icoPaddingBottom?: string | number;
  padding?: string | number;
  paddingLeft?: string | number;
  paddingTop?: string | number;
  paddingRight?: string | number;
  paddingBottom?: string | number;
  icoTextDecoration?: string;
  icoLineHeight?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlNavbarLink>`, the MJML tag `<mj-navbar-link>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlNavbarLinkProps {
  /** MJML default value: #000000 */
  color?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontStyle?: string;
  fontWeight?: string;
  href?: string;
  name?: string;
  /** MJML default value: _blank */
  target?: string;
  rel?: string;
  letterSpacing?: string | number;
  lineHeight?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 15px 10px */
  padding?: string | number;
  textDecoration?: string;
  textTransform?: string;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlAccordion>`, the MJML tag `<mj-accordion>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAccordionProps {
  containerBackgroundColor?: string;
  /** MJML default value: 2px solid black */
  border?: string;
  fontFamily?: string;
  iconAlign?: 'top' | 'middle' | 'bottom';
  iconWidth?: string | number;
  iconHeight?: string | number;
  iconWrappedUrl?: string;
  iconWrappedAlt?: string;
  iconUnwrappedUrl?: string;
  iconUnwrappedAlt?: string;
  iconPosition?: 'left' | 'right';
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 10px 25px */
  padding?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlAccordionElement>`, the MJML tag `<mj-accordion-element>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAccordionElementProps {
  backgroundColor?: string;
  border?: string;
  fontFamily?: string;
  iconAlign?: 'top' | 'middle' | 'bottom';
  iconWidth?: string | number;
  iconHeight?: string | number;
  iconWrappedUrl?: string;
  iconWrappedAlt?: string;
  iconUnwrappedUrl?: string;
  iconUnwrappedAlt?: string;
  iconPosition?: 'left' | 'right';
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlAccordionText>`, the MJML tag `<mj-accordion-text>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAccordionTextProps {
  backgroundColor?: string;
  fontSize?: string | number;
  fontFamily?: string;
  fontWeight?: string;
  letterSpacing?: string | number;
  lineHeight?: string;
  color?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 16px */
  padding?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlAccordionTitle>`, the MJML tag `<mj-accordion-title>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlAccordionTitleProps {
  backgroundColor?: string;
  color?: string;
  fontSize?: string | number;
  fontFamily?: string;
  fontWeight?: string;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  paddingTop?: string | number;
  /** MJML default value: 16px */
  padding?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlCarousel>`, the MJML tag `<mj-carousel>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlCarouselProps {
  /** MJML default value: center */
  align?: 'left' | 'center' | 'right';
  borderRadius?: string | number;
  containerBackgroundColor?: string;
  iconWidth?: string | number;
  leftIcon?: string;
  padding?: string | number;
  paddingTop?: string | number;
  paddingBottom?: string | number;
  paddingLeft?: string | number;
  paddingRight?: string | number;
  rightIcon?: string;
  /** MJML default value: visible */
  thumbnails?: 'visible' | 'hidden' | 'supported';
  tbBorder?: string;
  tbBorderRadius?: string;
  tbHoverBorderColor?: string;
  tbSelectedBorderColor?: string;
  tbWidth?: string | number;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The props of `<MjmlCarouselImage>`, the MJML tag `<mj-carousel-image>`. See `docs/mail.md#mail-views-in-react`. */
export interface MjmlCarouselImageProps {
  alt?: string;
  href?: string;
  rel?: string;
  /** MJML default value: _blank */
  target?: string;
  title?: string;
  src?: string;
  thumbnailsSrc?: string;
  borderRadius?: string | number;
  tbBorder?: string;
  tbBorderRadius?: string;
  cssClass?: string;
  mjmlClass?: string;
  children?: ReactNode;
}

/** The names of the components of `@marmeon/react/mail`. */
export type MjmlComponentName =
  | 'MjmlDocument'
  | 'MjmlAll'
  | 'MjmlClass'
  | 'MjmlHtmlAttribute'
  | 'MjmlSelector'
  | 'MjmlBody'
  | 'MjmlHead'
  | 'MjmlAttributes'
  | 'MjmlBreakpoint'
  | 'MjmlHtmlAttributes'
  | 'MjmlFont'
  | 'MjmlPreview'
  | 'MjmlStyle'
  | 'MjmlTitle'
  | 'MjmlHero'
  | 'MjmlButton'
  | 'MjmlColumn'
  | 'MjmlDivider'
  | 'MjmlGroup'
  | 'MjmlImage'
  | 'MjmlRaw'
  | 'MjmlSection'
  | 'MjmlSpacer'
  | 'MjmlText'
  | 'MjmlTable'
  | 'MjmlWrapper'
  | 'MjmlSocial'
  | 'MjmlSocialElement'
  | 'MjmlNavbar'
  | 'MjmlNavbarLink'
  | 'MjmlAccordion'
  | 'MjmlAccordionElement'
  | 'MjmlAccordionText'
  | 'MjmlAccordionTitle'
  | 'MjmlCarousel'
  | 'MjmlCarouselImage';
