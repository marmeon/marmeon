import { Head, useForm } from '@marmeon/react';

/** An address an editor enters, and the server calls it: the check that counts runs when it sends, not when the form is validated. */
export default function WebhookPing() {
  const form = useForm({ url: '' });
  return (
    <main>
      <Head title="Ping a webhook" />
      <h1>Ping a webhook</h1>
      <form
        method="post"
        action="/lab/webhook-ping"
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/lab/webhook-ping');
        }}
      >
        <label htmlFor="url">Address</label>
        <input id="url" name="url" type="url" value={form.data.url} onChange={(event) => form.set('url', event.target.value)} />
        {form.errors.url && <small role="alert">{form.errors.url}</small>}
        <button type="submit" disabled={form.processing}>
          Ping
        </button>
      </form>
    </main>
  );
}
