import type { PageProps } from '@bespokecore/core';
import type { AuthController } from '../AuthController.ts';

type Props = PageProps<AuthController['show']>;

export default function Login({ users }: Props) {
  return (
    <main>
      <h1>Sign in</h1>
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
