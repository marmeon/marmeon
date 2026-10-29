import { defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { rules as r, type Rule } from '@marmeon/validation';
import { LabConfig } from '../config.ts';
import { SurveyRepository, type Survey } from '../SurveyRepository.ts';
import { LabGate } from './ValidationLabController.ts';
import { LabController } from './ShowLabPageController.ts';

/**
 * A form whose fields are rows: the survey's questions. The schema is built per request, after the lab's gate said yes and
 * the binder found the survey — and it may ask the table, since a request that is refused never gets here.
 */
export const SurveyLabRequest = defineRequest({
  schema: async (resolve, ctx: HttpContext<{}, { survey: Survey }>) => {
    const questions = await resolve(SurveyRepository).questionsOf(ctx.params.survey.slug);
    const shape: Record<string, Rule<string | undefined, string | undefined>> = Object.fromEntries(
      questions.map((question) => {
        const rule = r.string().trim().max(500);
        return [question.name, question.required ? rule.required() : rule.optional()];
      }),
    );
    return r.object({ answers: r.object(shape) });
  },
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** The survey's form: one text field per question. */
export class ShowSurveyLabController extends LabController {
  readonly #surveys: SurveyRepository;

  constructor(config: LabConfig, surveys: SurveyRepository) {
    super(config);
    this.#surveys = surveys;
  }

  async handle(ctx: HttpContext<{}, { survey: Survey }>) {
    this.enabled();
    const questions = await this.#surveys.questionsOf(ctx.params.survey.slug);
    return this.view('lab/Survey', {
      survey: ctx.params.survey.slug,
      questions: questions.map((question) => ({ name: question.name, label: question.label, required: question.required })),
    });
  }
}

/** Takes the answers — valid means nothing more here, nothing is saved. */
export class StoreSurveyLabController extends LabController {
  static request = SurveyLabRequest;

  handle(ctx: ContextOf<typeof SurveyLabRequest>) {
    this.enabled();
    const count = Object.values(ctx.body.answers).filter((answer) => answer !== '').length;
    return this.redirect(`/lab/surveys/${ctx.params.survey.slug}`).flash('toast', { kind: 'success', message: `Thank you: ${count} answers — nothing was saved.` });
  }
}
