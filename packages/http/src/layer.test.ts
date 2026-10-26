import { defineRoutes, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { CloseLayerResult } from './layer.ts';
import { LAYER_CLOSE_HEADER, PAGE_HEADER, PROTOCOL_VERSION, REGION_HEADER } from './protocol.ts';

const router = new Router().load(
  defineRoutes((Route) => {
    Route.get('/users/:id', () => 'user').name('user-profile.show');
    Route.localized().get('/about', () => 'about').name('about');
  }),
);

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://app.test/profile/edit', { method: 'POST', headers });
}

describe('CloseLayerResult', () => {
  it('redirects to a localized route in the request’s locale when no layer asks for the close', () => {
    const response = new CloseLayerResult().route('about' as never, {} as never).toResponse(request(), { routes: router, locale: 'de' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/de/about');
  });

  it('answers a layer’s request with the close, also when its fallback target is localized', async () => {
    const layer = request({ [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'layer' });
    const response = new CloseLayerResult({ layers: 2 }).route('about' as never, {} as never).toResponse(layer, { routes: router, locale: 'de' });
    expect(response.status).toBe(200);
    expect(response.headers.get(LAYER_CLOSE_HEADER)).toBe('true');
    expect(await response.json()).toEqual({ close: { layers: 2 } });
  });

  it('redirects to a route that is not localized without a locale prefix', () => {
    const response = new CloseLayerResult().route('user-profile.show', { id: 7 }).toResponse(request(), { routes: router, locale: 'de' });
    expect(response.headers.get('location')).toBe('/users/7');
  });
});
