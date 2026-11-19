import { Head, useForm } from '@marmeon/react';

/**
 * A message for the `ops` destination, posted through `CHAT_WEBHOOKS` (only logged under `CHAT_DRIVER=log`).
 * `unavailable`: why `ops` cannot be used (the app needs an `ops` entry in `CHAT_WEBHOOKS`), or null.
 */
export default function Chat({ unavailable }: { unavailable: string | null }) {
  const form = useForm({ message: '' });
  return (
    <main>
      <Head title="Chat notification" />
      <h1>Post to the ops channel</h1>
      {unavailable && <p role="alert">{unavailable}</p>}
      <form
        method="post"
        action="/lab/chat"
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/lab/chat');
        }}
      >
        <label htmlFor="message">Message</label>
        <input id="message" name="message" type="text" value={form.data.message} onChange={(event) => form.set('message', event.target.value)} />
        {form.errors.message && <small role="alert">{form.errors.message}</small>}
        <button type="submit" disabled={form.processing}>
          Post
        </button>
      </form>
    </main>
  );
}
