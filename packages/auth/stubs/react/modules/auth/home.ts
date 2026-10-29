import type { RouteName } from '@marmeon/router';

/**
 * The page people land on after they sign in, register or confirm their address, and where a signed-in person who opens a guest page
 * is sent. Change the route name here to move them; the controllers, `routes.ts` and the layout read it from this one constant.
 * It names a route without path parameters, outside `Route.localized()`: the server builds its URL with `Router.url`, which needs every parameter.
 * A view cannot import it into `<Link route>`: the build reads route names written out, so a view takes the URL from the page's props.
 */
export const HOME = 'dashboard' satisfies RouteName;
