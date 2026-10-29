import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const AskQuestionRequest = defineRequest({
  schema: r.object({ question: r.string().required() }),
  messages: { 'question.required': 'app.talk.question_required' },
});

/** `POST /talks/:talk/questions`: a question for the talk. A missing one is reported in the talk's language. */
export class AskQuestionController extends Controller {
  static request = AskQuestionRequest;

  handle(ctx: ContextOf<typeof AskQuestionRequest>) {
    return { asked: ctx.body.question };
  }
}
