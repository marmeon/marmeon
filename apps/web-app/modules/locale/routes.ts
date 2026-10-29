import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { RequestLocale } from '@marmeon/i18n';
import { AskQuestionController } from './controllers/AskQuestionController.ts';
import { ShowTalkController } from './controllers/ShowTalkController.ts';
import { UpdateLocaleController } from './controllers/UpdateLocaleController.ts';
import { TalkCatalog } from './TalkCatalog.ts';

export default defineRoutes((Route) => {
  // A POST (with the CSRF token), never a GET: a link on another site must not switch the language.
  // Open to everyone, and limited per client: it writes the language into the session and, for a signed-in user, into that user's own
  // `locale`; it takes a supported language only.
  Route.middleware(throttle('locale')).authorize(everyone).post('/locale', UpdateLocaleController).name('locale.update');

  // A talk is held in one language, and its page speaks it without the language in the URL. The hook runs once the record is
  // bound and the checks have passed, so the 404 or 403 of a talk is still in the visitor's language. A language the app does
  // not support leaves the visitor's.
  // Every talk is public to read; questions go to the talks that take them.
  Route.authorize(everyone)
    .bind('talk', TalkCatalog, { public: true })
    .afterAuthorize((ctx, resolve) => {
      resolve(RequestLocale).use(ctx.params.talk.language);
    })
    .get('/talks/:talk', ShowTalkController)
    .name('talks.show');
  Route.bind('talk', TalkCatalog)
    .authorize((ctx) => ctx.params.talk.takesQuestions)
    .afterAuthorize((ctx, resolve) => {
      resolve(RequestLocale).use(ctx.params.talk.language);
    })
    .middleware(throttle('talks'))
    .post('/talks/:talk/questions', AskQuestionController)
    .name('talks.ask');
});
