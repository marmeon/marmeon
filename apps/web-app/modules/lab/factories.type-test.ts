// Type guarantees of a factory for a table with a oneOf() column — checked by `tsc`, never run.
import { defineFactory, type Factories, type FactoryDefinition } from '@marmeon/database';
import { SurveyQuestionFactory } from './factories/SurveyQuestionFactory.ts';

declare const factories: Factories;

// A literal from the union needs no `as const`: in the definition, a state, a function state and an override.
defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n', label: 'l', kind: 'choice' }), {
  states: { text: { kind: 'text' }, pick: () => ({ kind: 'choice' }) },
});
factories.for(SurveyQuestionFactory).make({ kind: 'choice' });
factories.for(SurveyQuestionFactory).state('choice').make();

// @ts-expect-error — a kind outside the union
defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n', label: 'l', kind: 'essay' }));
// @ts-expect-error — a kind outside the union in a state
defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n', label: 'l' }), { states: { essay: { kind: 'essay' } } });
// @ts-expect-error — a kind outside the union in a function state
defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n', label: 'l' }), { states: { essay: () => ({ kind: 'essay' }) } });
// @ts-expect-error — a required column is missing
defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n' }));
// @ts-expect-error — a kind outside the union in an override
factories.for(SurveyQuestionFactory).make({ kind: 'essay' });
// @ts-expect-error — a state the factory does not have
factories.for(SurveyQuestionFactory).state('essay');
// @ts-expect-error — a table the app does not have
defineFactory('nope', () => ({}));
const Plain = defineFactory('lab_survey_questions', () => ({ survey: 's', name: 'n', label: 'l' }));
// @ts-expect-error — a factory without states has no state to name
factories.for(Plain).state('x');

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type StateNames<F> = F extends FactoryDefinition<any, any, infer S> ? S : never;
export function StateNamesAreLiterals(names: Equal<StateNames<typeof SurveyQuestionFactory>, 'choice' | 'pick'>, none: Equal<StateNames<typeof Plain>, never>) {
  const ok: [true, true] = [names, none];
  return ok;
}
