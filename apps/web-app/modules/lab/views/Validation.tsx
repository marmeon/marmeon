import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { ShowValidationLabController } from '../controllers/ValidationLabController.ts';

/** What the inputs hold — strings and checkboxes; the rules read them (`age: '42'` is a number to `r.integer()`). */
interface Fields {
  name: string;
  email: string;
  website: string;
  age: string;
  starts: string;
  ends: string;
  port: string;
  time_zone: string;
  at: string;
  invite: string;
  inviter: string;
  kind: 'person' | 'company';
  vat: string;
  terms: boolean;
}

type TextField = Exclude<keyof Fields, 'kind' | 'terms'>;

/**
 * The rules of @marmeon/validation: a form whose schema is `rules` — messages in the request's language, the
 * field's name from `attributes`, a taken address told on submit only; `when` (a company's VAT number), an async `custom`
 * (an invitation code), `r.localDateTime()` (a time typed in a zone), `exists` (an account that invites), `r.date()` and `r.port()`. "As after a race" sends the same form to a
 * route without `unique`: the unique index answers through `failOnDuplicate()`, with the same message.
 */
export default function Validation(_props: PageProps<ShowValidationLabController>) {
  const form = useForm<Fields>({ name: '', email: '', website: '', age: '', starts: '', ends: '', port: '', time_zone: '', at: '', invite: '', inviter: '', kind: 'person', vat: '', terms: false });
  const error = (name: keyof Fields | '_') =>
    form.errors[name] && (
      <small role="alert" data-error={name}>
        {' '}
        {form.errors[name]}
      </small>
    );
  const field = (name: TextField, label: string, type = 'text') => (
    <p>
      <label htmlFor={name}>{label}</label>
      <br />
      <input id={name} name={name} type={type} value={form.data[name]} onChange={(event) => form.set(name, event.target.value)} aria-invalid={!!form.errors[name]} />
      {error(name)}
    </p>
  );
  const send = (path: string) => void form.post(path);
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
          send('/lab/validation');
        }}
      >
        {error('_')}
        {field('name', 'Name')}
        {field('email', 'E-mail', 'email')}
        {field('website', 'Website', 'url')}
        {field('age', 'Age', 'number')}
        {field('starts', 'Starts on', 'date')}
        {field('ends', 'Ends on', 'date')}
        {field('port', 'Port', 'number')}
        {field('time_zone', 'Time zone (Europe/Berlin)')}
        {field('at', 'At', 'datetime-local')}
        {field('invite', 'Invitation code')}
        {field('inviter', 'Invited by (an account\'s e-mail)', 'email')}
        <p>
          <label htmlFor="kind">Kind</label>
          <br />
          <select id="kind" name="kind" value={form.data.kind} onChange={(event) => form.set('kind', event.target.value as Fields['kind'])}>
            <option value="person">Person</option>
            <option value="company">Company</option>
          </select>
        </p>
        {form.data.kind === 'company' && field('vat', 'VAT number')}
        <p>
          <label>
            <input type="checkbox" name="terms" checked={form.data.terms === true} onChange={(event) => form.set('terms', event.target.checked)} /> I accept the terms
          </label>
          {error('terms')}
        </p>
        <button type="submit" disabled={form.processing}>
          Check
        </button>{' '}
        <button type="button" disabled={form.processing} onClick={() => send('/lab/validation/race')}>
          Check as after a race (no unique rule)
        </button>
      </form>
    </main>
  );
}
