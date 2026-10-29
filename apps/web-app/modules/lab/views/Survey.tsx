import type { FormOf, PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { ShowSurveyLabController, StoreSurveyLabController } from '../controllers/SurveyLabController.ts';

/** A form whose fields come from rows: the survey's questions, and the schema the server builds from the same rows. */
export default function Survey({ survey, questions }: PageProps<ShowSurveyLabController>) {
  const form = useForm<FormOf<StoreSurveyLabController>>({ answers: Object.fromEntries(questions.map((question) => [question.name, ''])) });
  return (
    <main>
      <Head title={`Survey ${survey}`} />
      <h1>Survey {survey}</h1>
      <form
        method="post"
        action={`/lab/surveys/${survey}`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post(`/lab/surveys/${survey}`);
        }}
      >
        {questions.map((question) => {
          // The questions are rows, so their fields are known at run time only.
          const error = (form.errors as Record<string, string | undefined>)[`answers.${question.name}`];
          return (
            <p key={question.name}>
              <label htmlFor={question.name}>
                {question.label}
                {question.required ? ' *' : ''}
              </label>
              <br />
              <input
                id={question.name}
                name={question.name}
                value={form.data.answers[question.name] ?? ''}
                onChange={(event) => form.set('answers', { ...form.data.answers, [question.name]: event.target.value })}
                aria-invalid={!!error}
              />
              {error && (
                <small role="alert" data-error={question.name}>
                  {' '}
                  {error}
                </small>
              )}
            </p>
          );
        })}
        <button type="submit" disabled={form.processing}>
          Send
        </button>
      </form>
    </main>
  );
}
