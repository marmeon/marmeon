import { Repository, type Row } from '@marmeon/database';
import type { RouteBinder } from '@marmeon/http';

/** The path's survey: the slug of the questions that make its form. */
export interface Survey {
  readonly slug: string;
}

/** The questions of the lab's surveys, kept as rows: a survey's form has the fields its rows say. */
export class SurveyRepository extends Repository<'lab_survey_questions'> {
  static table = 'lab_survey_questions' as const;

  /** Whether a survey has any question. */
  async has(survey: string): Promise<boolean> {
    return (await this.query().select('id').where('survey', '=', survey).limit(1).executeTakeFirst()) !== undefined;
  }

  /** A survey's questions in the order the form shows them. */
  questionsOf(survey: string): Promise<Row<'lab_survey_questions'>[]> {
    return this.query().selectAll().where('survey', '=', survey).orderBy('position').orderBy('name').execute();
  }
}

/** Route binder of `:survey`: a slug that has questions, or a 404. */
export class Surveys implements RouteBinder<Survey> {
  readonly #questions: SurveyRepository;

  constructor(questions: SurveyRepository) {
    this.#questions = questions;
  }

  async resolveRouteBinding(value: string): Promise<Survey | undefined> {
    return (await this.#questions.has(value)) ? { slug: value } : undefined;
  }
}
