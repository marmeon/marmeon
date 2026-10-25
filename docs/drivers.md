# Drivers

## Introduction

A driver is the part of a service that talks to the outside: the queue's `database` and `redis`, a disk's S3 bucket. The framework
ships the common ones. A package or an app brings its own by listing a factory on its service provider, and an environment
variable then selects it by name, like a built-in one:

```ts title="src/SqsServiceProvider.ts"
import type { QueueDriverFactory } from '@marmeon/queue';

const sqs: QueueDriverFactory = ({ name, container, clock }) => ({
  driver: new SqsQueueDriver(container.make(SqsConfig), clock),
  queue: 'default',
  retryAfterSeconds: 90,
});

export class SqsServiceProvider {
  static config = [SqsConfig];
  static queueDrivers = { sqs };
}
```

```sh title=".env"
QUEUE_DRIVER=sqs
```

A package whose provider is found by `marmeon discover` brings its driver without any code in the app. An app lists the provider
in `providers` of `defineApplication()`, like any other.

## Bringing a driver

A provider lists drivers in a static record, by name. The record's key tells which service the drivers belong to:

| Static | Service | Selected by |
| --- | --- | --- |
| `queueDrivers` | [Queues](queues.md#queue-drivers-and-failed-job-stores) | `QUEUE_DRIVER` |
| `failedJobDrivers` | [Queues](queues.md#queue-drivers-and-failed-job-stores) | `QUEUE_FAILED_DRIVER` |
| `diskDrivers` | [File storage](storage.md#disk-drivers) | `driver` of a disk in `defineStorage()` |
| `cacheDrivers` | [Cache](cache.md#cache-drivers) | `CACHE_DRIVER` |
| `mailDrivers` | [Mail transports](#mail-transports) | `MAIL_DRIVER` |

A driver reads its own settings through a configuration of its own, which its provider lists in `static config`
([package development](package-development.md#configuration)). The factory resolves what it needs from the `container` it is given.

The start stops, with a message that names the provider and the name, in these cases:

- **The name is malformed.** A name is lowercase letters, digits and dashes, and starts with a letter: `sqs`, `memory-x`.
- **The name belongs to a built-in driver.** The built-in names are reserved, so that no installed package silently replaces the
  `redis` or `database` driver and with it the way jobs are claimed or payloads are kept.
- **Two providers bring the same name.** There is no "last one wins". Rename one of them.
- **The environment selects a name nobody brought.** The message lists the names there are, so a typo never ends up at another
  driver.

These checks run at every start, also when the driver is not selected. A provider that has no other content than a driver record
is still a valid provider.

The factory itself runs when the driver is selected by the environment, at the start: a factory that throws, or returns a
driver that lacks a required member, stops the start then. A driver nobody selects is built on first use and fails there. A
factory that failed is not run again; later lookups get the same error.

A provider class that extends another inherits its static record: with both listed, the name appears twice and the start stops.
Give the subclass a record of its own.

## Contracts are stable

The interfaces a driver implements, such as `QueueDriver`, `FailedJobStore` and `DiskDriver`, are public API. From 1.0 on, a new method comes
only as an optional member, or with a default that keeps the old behaviour, so a driver written today keeps working. A member that
is optional says in its documentation what the framework does without it.

## Queue drivers and failed-job stores

A queue driver implements `QueueDriver` and returns a `QueueConnection` from its factory: the driver, the connection's default
queue and `retryAfterSeconds`, the seconds before a claim may be taken again. A failed-job store implements `FailedJobStore`.

```ts
import type { FailedJobStoreFactory } from '@marmeon/queue';

const dynamo: FailedJobStoreFactory = ({ container }) => new DynamoFailedJobs(container.make(DynamoConfig));

export class DynamoServiceProvider {
  static config = [DynamoConfig];
  static failedJobDrivers = { dynamo };
}
```

The driver is built once, at the start when `QUEUE_DRIVER` selects it, and on first use otherwise. A factory that returns
no driver, no queue name, or a `retryAfterSeconds` that is not a positive number stops the start. A custom connection is named like its
driver: dispatch to it with `{ connection: 'sqs' }`, work it with `queue:work --connection=sqs`.

What a driver must guarantee:

- **A claim is atomic.** Two workers never hold one job. `ack`, `release` and `fail` act only on the claim they are given, and
  return `false` when the claim has expired and another worker holds the job.
- **`retryAfterSeconds` is honoured.** `reserve` takes a job again whose claim is older than `retryAfterSeconds`, and never earlier. The
  framework checks every job's `timeout` plus the worker's `--stop-timeout` against it when `queue:work` starts, but only the
  driver can keep a claim from being taken too early. A driver that ignores it runs a job twice.
- **The payload is opaque.** It arrives as the queue stores it. A job with `static encrypted` is encrypted before `push`, so the
  driver sees only ciphertext and stores it as it is. The record inside carries a version the worker checks, never the driver.
- **`release` may carry `availableAt`.** `release(job, delaySeconds, { availableAt })` gives the time the job can be claimed again (epoch
  ms). Write it into the stored payload's `availableAt` field, as `withAvailableAt` from `@marmeon/queue/internal` does, so a worker
  that cannot read the record yet counts how long it waited from there. A driver that ignores the option leaves the payload as it
  was; a job released with a long delay may then fail sooner than it should after a deploy.

What happens without an optional member:

| Member | Without it |
| --- | --- |
| `reserveAny` | A worker without `--queue` goes round `queues()` and reserves from each queue itself. |
| `counts` | The devtools show the size of a queue, not its split into ready, delayed and reserved jobs. |
| `using` | `queue.using(trx)` refuses with an error: the driver cannot write into a database transaction. |
| `joinsTransaction` | A dispatch inside a transaction waits for the outermost commit, and is dropped on a rollback. The job never exists before the data it depends on does. |
| `FailedJobStore.prune` | Required: `queue:prune-failed` calls it. |

`using` and `joinsTransaction` apply to drivers that keep jobs in the app's database. Any other driver leaves them out and gets
the safe behaviour in the table.

## Disk drivers

A disk driver implements `DiskDriver` and is a `DiskDriverFactory`: it gets the options of the disk from `defineStorage()` and the
disk's `name`, the app `root` and the `container`, and returns the disk. A disk selects its driver by name, like the built-in
`local`, `s3` and `memory`. The built-in drivers are configured in `defineStorage()`, not constructed — their classes are not
part of the public API; a driver of your own implements `DiskDriver`:

```ts title="src/GcsServiceProvider.ts"
import type { DiskDriverFactory } from '@marmeon/storage';

declare module '@marmeon/storage' {
  interface DiskDrivers {
    gcs: { readonly bucket: string };
  }
}

const gcs: DiskDriverFactory<{ bucket: string; visibility?: 'public' | 'private' }> = (options, { name, container }) =>
  new GcsDisk(name, options, container.make(GcsConfig));

export class GcsServiceProvider {
  static config = [GcsConfig];
  static diskDrivers = { gcs };
}
```

```ts title="config/storage.ts"
export const AppStorage = defineStorage({
  default: 'media',
  disks: { media: { driver: 'gcs', bucket: 'files' } }, // without `bucket` this is a type error
});
```

Declaring the options in `DiskDrivers` is what makes `defineStorage()` check them; every disk has `visibility` and `url` on top.
A disk whose `driver` nobody brought stops the start with the disk's name and the drivers there are. The disks of a
driver are built at the start, so a factory that throws, or returns something that is not a `DiskDriver` (every member of the
contract is required), stops it then. The test fake replaces every disk with a memory disk, so a test never reaches a
provider's driver.

What the framework keeps for a disk of a provider's driver, whatever the driver does:

- **Visibility is the configuration's.** The returned disk must have the configured `name` and `visibility`, or the start stops.
  `url()` on a private disk is refused by the framework and never reaches the driver, and a private disk with a `url` option
  stops the start.
- **`temporaryUrl()` gets whole seconds.** The app writes `expiresIn` as seconds or a [`Duration`](time.md#spans-of-time); the
  framework turns it into `expiresInSeconds`, a whole number of at least 1, before it calls the driver's `temporaryUrl(key,
  { expiresInSeconds, filename?, base? })`. A driver's factory returns a `DiskDriver`: the members of a disk, with that signature.
- **A private file is reached only through a signed URL.** `temporaryUrl()` of a private disk must sign the URL and let it expire.
  That is the driver's job: the framework cannot tell a signature from a long string and refuses only an empty result. A driver
  that returns an unsigned URL publishes its private files.
- **The app serves nothing for it.** Routes for public paths and signed local URLs exist for `local` and `memory` disks only. The
  `url` of a provider's disk is an address the driver owns, such as a CDN.
- **Keys are checked before the driver sees them.** Every key, and the directory of `list()`, goes through `normalizeKey()` and
  `normalizeDirectory()` first: `..`, absolute paths, backslashes, empty segments and control characters are refused with
  `InvalidKeyError`, as on the built-in disks. Both functions are exported for a driver that checks keys it builds itself.
- **The disk is held privately.** The app gets a wrapper that delegates to the driver's disk; its `name` and `visibility` are the
  configured ones.

Every member of `DiskDriver` is required except `close()`, which the framework calls at shutdown when the disk has one — close a client
or a connection there.

## Cache drivers

A cache driver is a pair: a `CacheStore` for the entries and a `LockStore` for the locks. The factory returns both, and neither
is optional, so there is no cache without atomic locks. `cache.lock()`, `withoutOverlapping`, `onOneServer()` and unique jobs
all take their locks from the `locks` half.

```ts
import type { CacheDriverFactory } from '@marmeon/cache';

const dynamo: CacheDriverFactory = ({ name, container, clock, prefix }) => {
  const table = new DynamoTable(container.make(DynamoConfig), prefix);
  return { store: new DynamoStore(table, clock), locks: new DynamoLocks(table, clock) };
};

export class DynamoServiceProvider {
  static config = [DynamoConfig];
  static cacheDrivers = { dynamo };
}
```

```sh title=".env"
CACHE_DRIVER=dynamo
```

One object may implement both interfaces and be returned as `{ store: both, locks: both }`, as the built-in stores do. A driver
built from two services, such as entries in a fast store and locks in a store that is safe to share, returns two objects.

`CACHE_PREFIX` is already part of every key and lock name the driver is given. The `prefix` of the factory's context is for a
namespace of the driver's own, such as a table or an index.

The driver is built once, at the start, when `CACHE_DRIVER` selects it. At that point the framework also tries the locks once:
it takes a lock nobody else uses, checks that a second owner cannot take it and cannot free it, frees it with its own owner, and
checks that `add` does not overwrite a key. A driver that fails stops the start with what it did wrong, because a lock store that
lets two owners in would run a `withoutOverlapping` job twice.

What a store must guarantee:

- **`add` is atomic.** Of two calls at once for one key, one writes. It writes only when the key is absent or expired.
- **`increment` is atomic.** Two processes counting at once never lose a count. A missing, expired or non-integer key starts
  over at `by` with the given expiry; an existing integer keeps its expiry, so a rate limit window does not restart with every hit.
- **Expiry is the store's.** `read` returns no entry past its `expires`. The framework drops an entry that does come back
  expired, but an expired entry that `add` still treats as present blocks the next writer.
- **`clear` removes entries and never a lock.** `marmeon cache:clear` must not free what a running job holds. This is why
  locks are a separate interface: nothing in `clear` has a lock to free.

What a lock store must guarantee:

- **`lock` is atomic.** A lock goes to one owner. It is taken when it is free, expired, or already the caller's own.
- **Only the owner frees a lock.** `unlock(name, owner)` frees it only while `owner` holds it, and an expired lock that another
  owner took over stays. The framework never calls it with an empty owner.
- **A lock expires.** A holder that crashed cannot block everyone forever; `lockOwner` returns nothing for an expired lock.

The framework hands the driver only text as keys, lock names and owners, answers `true` only when the driver returned exactly
`true`, and never serves an entry past its expiry. These are checks on top of the contract, not a replacement for it: whether a
lock is atomic across processes is the driver's to guarantee.

`prune` is optional on both halves. `marmeon cache:prune` calls each one that has it and adds up the counts; when neither has
it, the command says the entries expire on their own. A store that expires entries itself, as Redis does, leaves it out.

## Mail transports

A mail transport implements `MailTransport` and is a `MailDriverFactory`: it gets the `name` it was registered under, the
`container` and a `logger` of the `mail` channel, and returns the transport. `MAIL_DRIVER` selects it by name,
like the built-in `log`, `array` and `smtp`:

```ts title="src/PostmarkServiceProvider.ts"
import type { MailDriverFactory } from '@marmeon/mail';

const postmark: MailDriverFactory = ({ container }) => new PostmarkTransport(container.make(PostmarkConfig));

export class PostmarkServiceProvider {
  static config = [PostmarkConfig];
  static mailDrivers = { postmark };
}
```

```sh title=".env"
MAIL_DRIVER=postmark
```

`send()` resolves with `{ messageId }`, the id the provider gave the mail, or `{ messageId: undefined }` when it gave none.
`mailer.send()` hands it on as the `messageId` of the sent mail; it is what a delivery report from the provider refers to:

```ts
class PostmarkTransport implements MailTransport {
  async send(message: MailMessage): Promise<MailReceipt> {
    const response = await this.#client.post('/email', toPostmark(message));
    return { messageId: response.MessageID };
  }
}
```

The transport is built at the start when `MAIL_DRIVER` selects it, so a factory that throws, or returns something without a
`send()`, stops the start. A `MAIL_DRIVER` nobody brought stops it too, with the names there are. A transport may have a `close()`: the framework calls it at
shutdown, to close connections it holds. Mails that are queued reach the
same transport in the worker.

A transport a package brings is responsible for its own route to the provider. The framework's `MAIL_SECURE` and `MAIL_REQUIRE_TLS`
apply to `smtp` only: a transport of your own sends over TLS, checks the certificate of the provider and keeps its credentials out
of the messages it throws and logs. Read your own settings from a configuration of your own, listed in `static config`.
