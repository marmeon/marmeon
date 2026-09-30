import type { PageProps } from '@bespokecore/http';
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';

type Props = PageProps<ShowLoginController>;

export default function Login({ appName, users, csrfToken, flash, errors }: Props) {
  return (
    <main>
      <h1>Sign in to {appName}</h1>
      {flash.status && <p role="status">{flash.status}</p>}
      {errors.user_id && <p role="alert">{errors.user_id[0]}</p>}
      <p>Demo login — pick a user:</p>
      {users.map((user) => (
        <form key={user.id} method="post" action="/login">
          <input type="hidden" name="_token" value={csrfToken} />
          <input type="hidden" name="user_id" value={user.id} />
          <button type="submit">Continue as {user.name}</button>
        </form>
      ))}
    </main>
  );
}
