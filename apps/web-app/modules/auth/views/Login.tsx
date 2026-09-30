import type { PageProps } from '@bespokecore/http';
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';

type Props = PageProps<ShowLoginController>;

export default function Login({ appName, users, status, error }: Props) {
  return (
    <main>
      <h1>Sign in to {appName}</h1>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      <p>Demo login — pick a user:</p>
      {users.map((user) => (
        <form key={user.id} method="post" action="/login">
          <input type="hidden" name="user_id" value={user.id} />
          <button type="submit">Continue as {user.name}</button>
        </form>
      ))}
    </main>
  );
}
