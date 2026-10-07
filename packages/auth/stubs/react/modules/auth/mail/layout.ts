import type { Translator } from '@marmeon/i18n';
import { mjml, type Html } from '@marmeon/mail';

/**
 * The frame of every mail of the app — a function returning `mjml`, so mails nest their body into it. `t` speaks the
 * recipient's language (`translator.forLocale(user.locale)`), which also goes into `<mjml lang>`.
 */
export function layout(t: Translator, { preview, body }: { preview: string; body: Html }) {
  return mjml`<mjml lang="${t.locale}">
  <mj-head>
    <mj-preview>${preview}</mj-preview>
    <mj-attributes>
      <mj-all font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" />
      <mj-text font-size="15px" line-height="1.5" color="#1f2933" />
      <mj-button background-color="#1f2933" color="#ffffff" border-radius="6px" font-size="15px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f5f7" width="560px">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>${body}</mj-column>
    </mj-section>
    <mj-section padding="12px">
      <mj-column><mj-text font-size="12px" color="#7b8794" align="center">${t.get('auth.mail.app')}</mj-text></mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}
