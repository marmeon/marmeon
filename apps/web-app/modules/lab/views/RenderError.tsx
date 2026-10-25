import type { PageProps } from '@marmeon/http';
import { Head, type ErrorFallbackProps, type LayoutProps } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowRenderErrorLabController } from '../controllers/ShowLabPageController.ts';

/** What the frame shows in place of its page when that throws: inside the frame, which stays — with a retry. */
function FrameError({ title, message, retry }: ErrorFallbackProps) {
  return (
    <div role="alert" data-render-error>
      <h2>{title}</h2>
      <p>{message}</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/** A layout with `error`: it catches what fails below it and shows `FrameError` inside itself. */
function Frame({ children }: LayoutProps) {
  return <section data-lab-frame>{children}</section>;
}
Frame.error = FrameError;

/** Throws while rendering — in the browser only, since the page opts out of server rendering. */
export default function RenderError({ broken }: PageProps<ShowRenderErrorLabController>) {
  if (broken) throw new Error('The lab’s page fails while the browser renders it.');
  return (
    <main>
      <Head title="Render error" />
      <h1>Render error</h1>
      <p data-render-fixed>This page rendered fine.</p>
    </main>
  );
}
RenderError.layout = [AppLayout, Frame];
RenderError.ssr = false as const;
