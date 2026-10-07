import type { ActionException } from '@marmeon/react';
import { useTranslation } from '@marmeon/react';

/** Why an action failed, for the message — 401/419 mean the session is gone: reload, nothing is retried by itself (E59). */
export function failureReason(exception: ActionException): 'signed_out' | 'expired' | 'offline' | 'forbidden' | 'other' {
  if (exception.type === 'network') return 'offline';
  if (exception.status === 401) return 'signed_out';
  if (exception.status === 419) return 'expired';
  if (exception.status === 403 || exception.status === 404) return 'forbidden';
  return 'other';
}

/** The notice of an action that failed — where it was started, until the next attempt. */
export function ActionFailure({ exception }: { exception: ActionException | undefined }) {
  const t = useTranslation('app');
  if (!exception) return null;
  return <p role="alert">{t('action_failed', { reason: failureReason(exception) })}</p>;
}
