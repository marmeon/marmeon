import type { RouteName } from '@marmeon/router';

/**
 * The page people land on after they sign in, register or confirm their address, and where a signed-in person who opens a guest page
 * is sent. It names a route without path parameters, outside `Route.localized()`: the server builds its URL with `Router.url`, which needs
 * every parameter. Change the route name here to move them; the controllers and `routes.ts` read it from this one constant. A view cannot
 * import it into `<Link route>`: the build reads route names written out, so a view takes the URL from the controller's props.
 */
export const HOME = 'user-profile.me' satisfies RouteName;
