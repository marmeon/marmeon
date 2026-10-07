import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { ShowValidationLabController } from '../controllers/ValidationLabController.ts';

/** What the inputs hold — strings and a checkbox; the rules read them (`age: '42'` is a number to `r.integer()`). */
interface Fields {
  name: string;
  email: string;
  website: string;
  age: string;
  terms: boolean;
}

/**
 * The rules of @marmeon/validation (W10 step 3): a form whose schema is `rules` — messages in the request's language, the field's
 * name from `attributes`, a taken address told on submit only (E197). Send it empty, with a known address, in German.
 */
export default function Validation(_props: PageProps<ShowValidationLabController>) {
  const form = useForm<Fields>({ name: '', email: '', website: '', age: '', terms: false });
  const field = (name: 'name' | 'email' | 'website' | 'age', label: string, type = 'text') => (
    <p>
      <label htmlFor={name}>{label}</label>
      <br />
      <input id={name} name={name} type={type} value={form.data[name]} onChange={(event) => form.set(name, event.target.value)} aria-invalid={!!form.errors[name]} />
      {form.errors[name] && (
        <small role="alert" data-error={name}>
          {' '}
          {form.errors[name]}
        </small>
      )}
    </p>
  );
  return (
    <main>
      <Head title="Validation lab" />
      <h1>Validation lab</h1>
      <form
        method="post"
        action="/lab/validation"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/lab/validation');
        }}
      >
        {field('name', 'Name')}
        {field('email', 'E-mail', 'email')}
        {field('website', 'Website', 'url')}
        {field('age', 'Age', 'number')}
        <p>
          <label>
            <input type="checkbox" name="terms" checked={form.data.terms === true} onChange={(event) => form.set('terms', event.target.checked)} /> I accept the terms
          </label>
          {form.errors.terms && (
            <small role="alert" data-error="terms">
              {' '}
              {form.errors.terms}
            </small>
          )}
        </p>
        <button type="submit" disabled={form.processing}>
          Check
        </button>
      </form>
    </main>
  );
}
