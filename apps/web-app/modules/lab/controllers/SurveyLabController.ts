import { defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { rules as r, type Rule } from '@marmeon/validation';
import { LabConfig } from '../config.ts';
import { OptionsRule, SurveyRepository, type Survey } from '../SurveyRepository.ts';
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
        // A choice takes one of its options, which the column's type says are a list of words; a free text takes any text.
        const choice = question.options?.length ? r.in(question.options as [string, ...string[]]) : undefined;
        const text = r.string().trim().max(500);
        const rule = choice ? (question.required ? choice : choice.optional()) : question.required ? text.required() : text.optional();
        return [question.name, rule as Rule<string | undefined, string | undefined>];
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
      questions: questions.map((question) => ({ name: question.name, label: question.label, required: question.required, options: question.options ?? [] })),
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

/**
 * A choice for a survey: its words come from a request, so the schema checks them before they are written as JSON. The column's
 * type (`readonly string[]`) promises what a read gets; only this schema makes it true for what this route writes.
 */
export const AddQuestionLabRequest = defineRequest({
  schema: r.object({
    // The name becomes a key of the answers and of their errors, so it is a plain word.
    name: r.string().trim().required().max(60).regex(/^[a-z][a-z0-9_]*$/),
    label: r.string().trim().required().max(200),
    options: OptionsRule,
  }),
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** Adds a choice question to the survey in the path unless it has one of that name. */
export class AddQuestionLabController extends LabController {
  static request = AddQuestionLabRequest;

  readonly #surveys: SurveyRepository;

  constructor(config: LabConfig, surveys: SurveyRepository) {
    super(config);
    this.#surveys = surveys;
  }

  async handle(ctx: ContextOf<typeof AddQuestionLabRequest> & HttpContext<{}, { survey: Survey }>) {
    this.enabled();
    const { name, label, options } = ctx.body;
    await this.#surveys.addMissing([{ survey: ctx.params.survey.slug, name, label, options }]);
    return this.redirect(`/lab/surveys/${ctx.params.survey.slug}`);
  }
}
