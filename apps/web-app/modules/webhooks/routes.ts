import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone, verifyWebhook } from '@marmeon/http';
import { ReceivePaymentEventController } from './controllers/ReceivePaymentEventController.ts';

export default defineRoutes((Route) => {
  // Open to everyone, signed by the sender: no session and no token, so no `csrfExcept` either. The throttle comes first: a forged
  // request counts too.
  Route.authorize(everyone).middleware(throttle('webhooks.payments')).middleware(verifyWebhook('payments')).post('/webhooks/payments', ReceivePaymentEventController);
});
