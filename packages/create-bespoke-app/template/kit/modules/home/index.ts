import { defineModule } from '@bespokecore/core';
import routes from './routes.ts';

// The home page — written by create-bespoke-app's starter kit, yours to change (or remove: drop it from bootstrap/app.ts).
export default defineModule({
  name: 'home',
  routes,
});
