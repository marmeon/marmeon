/**
 * The framework's own entry points. Packages of this repository load their routes with `FRAMEWORK_ROUTES`, build pages
 * and speak the page protocol with the rest; an app has no reason to, and none of it is API — it can change in any release.
 * @internal
 */
export { isViewResult } from './view.ts';
export { isJsonResult } from './json.ts';
export { isIslandResult } from './island.ts';
export { isCloseLayerResult, isLayerResult } from './layer.ts';
export { isRedirectResult } from './redirect.ts';
export { ERROR_PAGE, LAYER_BACKDROP, pageName, scriptJson } from './page-support.ts';
export {
  ACTION_HEADER,
  ACTION_REDIRECT_HEADER,
  FLASH_HEADER,
  FLASH_WAITING_HEADER,
  LAYER_CLOSE_HEADER,
  LOCATION_HEADER,
  MAX_LAYER_DEPTH,
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  PAGE_HEADER,
  PAGE_SCRIPT_ID,
  APP_ORIGIN_META,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  protocolHeaders,
  PROTOCOL_VERSION,
  PURPOSE_HEADER,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  RELOAD_HEADER,
  speaksProtocol,
  VALIDATE_HEADER,
  VALIDATED_HEADER,
  VERSION_HEADER,
} from './protocol.ts';
export { answersWithData, isProtocolRequest, isVisit, PROTOCOL_REQUEST_HEADERS, SUPPORTED_PROTOCOLS } from './protocol-request.ts';
export { heldOnceProps, partialReloadOf, propOrigins, resolvePageProps } from './page-props.ts';
export { flashOf, serializedFlash } from './flash.ts';
export { BROWSER_ROUTES_FILE, matchesRoutePatterns, writeAppBrowserRoutes, writeBrowserRoutes } from './browser-routes.ts';
export { checkedChannel, isLiveChannel, liveOf, signedLive } from './live.ts';
export { IncomingRequest } from './server-closing.ts';
export { epochOf } from './session-epoch.ts';
export { ResponseLifecycle } from './response-lifecycle.ts';
export { isWebhookMiddleware, signWebhook } from './webhooks.ts';
export { FRAMEWORK_ROUTES } from '@marmeon/router/internal';
