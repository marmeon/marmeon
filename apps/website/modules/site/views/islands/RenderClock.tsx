import type { IslandProps } from '@marmeon/http';
import type { ShowRenderClockController } from '../../controllers/ShowRenderClockController.ts';

/** The island of the landing page: the time its answer was rendered. */
export default function RenderClock({ renderedAt }: IslandProps<ShowRenderClockController>) {
  return <time dateTime={renderedAt}>{renderedAt}</time>;
}
