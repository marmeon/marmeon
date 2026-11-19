import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import type { ShowLocalOidcAuthorizeController } from '../controllers/LocalOidcController.ts';

/**
 * The page of the local OpenID Connect provider: pick the name, the address and whether the address counts as verified, as a real provider's
 * account would say. Plain forms: the request that started the sign-in rides along in hidden fields and is checked again on the way back.
 * Cancel is a form of its own, with no person's fields, so a cleared field cannot stand in its way.
 */
export default function LocalOidcAuthorize({ params, errors }: PageProps<ShowLocalOidcAuthorizeController>) {
  const hidden = Object.entries(params).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);
  const error = (name: string) => {
    const messages = (errors as Record<string, readonly string[] | undefined>)[name];
    return messages?.[0] && <small role="alert"> {messages[0]}</small>;
  };
  return (
    <main>
      <Head title="Local provider" />
      <h1>Local provider</h1>
      <p>
        <small>For development only. Answer as whoever you like; nothing is checked.</small>
      </p>
      <form method="post" action="/_dev/oidc/authorize">
        {hidden}
        <input type="hidden" name="decision" value="approve" />
        <p>
          <label htmlFor="name">Name</label>
          <br />
          <input id="name" name="name" type="text" defaultValue="Ada Lovelace" maxLength={100} />
          {error('name')}
        </p>
        <p>
          <label htmlFor="email">E-mail address</label>
          <br />
          <input id="email" name="email" type="text" defaultValue="ada@example.com" maxLength={255} />
          {error('email')}
        </p>
        <p>
          <label htmlFor="verified">The provider vouches for the address</label>
          <br />
          <select id="verified" name="verified" defaultValue="true">
            <option value="true">Yes (verified)</option>
            <option value="false">No (not verified)</option>
          </select>
        </p>
        <button type="submit">Sign in</button>
      </form>
      <form method="post" action="/_dev/oidc/authorize">
        {hidden}
        <input type="hidden" name="decision" value="deny" />
        <button type="submit">Cancel</button>
      </form>
    </main>
  );
}
