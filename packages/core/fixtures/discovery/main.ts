// The fixture app: discovers installed packages, registers their providers, resolves.
import { createApplication, loadDiscoveredPackages } from '@bespokecore/core';
import { Greeting, Mailer, Money } from '@acme/mailer';
import { FakeMailer } from '@acme/mailer/testing';

// Called separately only to report `regenerated`; createApplication() would discover on its own.
const discovered = await loadDiscoveredPackages({ root: import.meta.dirname });
const { container } = await createApplication({
  root: import.meta.dirname,
  discover: false,
  providers: discovered.providers as never,
});

const attempt = (fn: () => unknown) => {
  try {
    return fn();
  } catch (error) {
    return (error as Error).message;
  }
};

console.log(
  JSON.stringify({
    packages: discovered.packages,
    regenerated: discovered.regenerated,
    sent: container.make(Mailer).send('ada@example.com'),
    retries: (container.make(Mailer) as unknown as { retries: number }).retries,
    fake: container.make(FakeMailer).send('bob@example.com'),
    greeting: container.make(Greeting).hello('Grace'),
    money: attempt(() => container.make(Money)),
  }),
);
