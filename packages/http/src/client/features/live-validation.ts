/**
 * Live validation (E62) as a feature: a form's fields checked against the server's request schema while they are filled in,
 * sent through what actions use of the navigator (`actionHost`). It holds nothing of the server's: each form's
 * `LiveValidation` keeps which fields were touched; the adapter keeps the errors.
 *
 * Prop-driven (E74): an adapter loads it on a form's first use (`loadLiveValidation`, `liveValidationOnFirstUse` in
 * `lazy.ts`) — in a chunk of its own, never in an app's first download.
 */
import { actionHost } from '../action-host.ts';
import { defineFeature } from '../feature.ts';
import { LiveValidation, sendLiveValidation, type LiveValidationOptions, type LiveValidationOutcome, type LiveValidationRequest } from '../live-validation.ts';

/** What adapters use of live validation. */
export interface LiveValidationFeature {
  /** One check of `request.fields` against the request schema of the route at `url` — sent as the form would be (minus passwords and files). */
  validate(url: string, request: LiveValidationRequest): Promise<LiveValidationOutcome>;
  /** The live validation of one form at `url`: touched fields, debounce, the check under way. */
  form(url: string, options: Omit<LiveValidationOptions, 'send'>): LiveValidation;
}

export const liveValidation = defineFeature('liveValidation', (host): LiveValidationFeature => {
  const actions = actionHost(host);
  const validate = (url: string, request: LiveValidationRequest) => sendLiveValidation(actions, url, request);
  return { validate, form: (url, options) => new LiveValidation({ ...options, send: (request) => validate(url, request) }) };
});
