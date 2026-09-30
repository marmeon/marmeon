import type { FormOf } from '@bespokecore/http/page';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, type VisitMethod, type VisitOptions } from './app.tsx';

/** The data of a form: the controller's schema input (`useForm<UpdateUserProfileController>`), or given directly. */
type FormFields<T> = [FormOf<T>] extends [never] ? T : FormOf<T>;

type Field<T> = keyof FormFields<T> & string;

export interface FormSubmitOptions extends Omit<VisitOptions, 'method' | 'data'> {
  onSuccess?: () => void;
  onError?: (errors: Record<string, string>) => void;
  onFinish?: () => void;
}

export interface Form<T> {
  readonly data: FormFields<T>;
  set<K extends Field<T>>(field: K, value: FormFields<T>[K]): void;
  setData(data: FormFields<T>): void;
  /** The first message per field, from the server's validation. */
  readonly errors: Partial<Record<Field<T>, string>>;
  readonly hasErrors: boolean;
  clearErrors(...fields: Field<T>[]): void;
  /** A request is in flight. */
  readonly processing: boolean;
  /** The last submit succeeded. */
  readonly wasSuccessful: boolean;
  /** The last submit succeeded less than two seconds ago — for a short "Saved." */
  readonly recentlySuccessful: boolean;
  /** Something differs from the initial data. */
  readonly isDirty: boolean;
  /** Back to the initial data — all fields or some. */
  reset(...fields: Field<T>[]): void;
  submit(method: VisitMethod, url: string, options?: FormSubmitOptions): Promise<void>;
  get(url: string, options?: FormSubmitOptions): Promise<void>;
  post(url: string, options?: FormSubmitOptions): Promise<void>;
  put(url: string, options?: FormSubmitOptions): Promise<void>;
  patch(url: string, options?: FormSubmitOptions): Promise<void>;
  delete(url: string, options?: FormSubmitOptions): Promise<void>;
}

/**
 * Form state and submission, typed from the endpoint's request schema:
 *
 * ```tsx
 * const form = useForm<UpdateUserProfileController>({ name: profile.name, bio: profile.bio });
 * <input value={form.data.name} onChange={(e) => form.set('name', e.target.value)} />
 * {form.errors.name && <p>{form.errors.name}</p>}
 * <button disabled={form.processing} onClick={() => form.put(`/users/${profile.id}`)}>Save</button>
 * ```
 *
 * The fields are the schema's *input* (what the browser sends), and the errors come
 * back from the server — a failed submit redirects back with `errors` in the page
 * props, without a reload and without losing what was typed.
 */
export function useForm<T>(initial: FormFields<T>): Form<T> {
  const { visit } = useRouter();
  const [defaults] = useState(initial);
  const [data, setData] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<Field<T>, string>>>({});
  const [processing, setProcessing] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const submit = useCallback(
    async (method: VisitMethod, url: string, { onSuccess, onError, onFinish, ...options }: FormSubmitOptions = {}) => {
      setProcessing(true);
      setWasSuccessful(false);
      try {
        const page = await visit(url, { preserveScroll: true, ...options, method, data: data as Record<string, unknown> });
        if (!page) return;
        const failed = firstMessages((page.props as { errors?: unknown }).errors) as Partial<Record<Field<T>, string>>;
        setErrors(failed);
        if (Object.keys(failed).length > 0) {
          onError?.(failed as Record<string, string>);
        } else {
          setWasSuccessful(true);
          setRecentlySuccessful(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setRecentlySuccessful(false), 2000);
          onSuccess?.();
        }
      } finally {
        setProcessing(false);
        onFinish?.();
      }
    },
    [visit, data],
  );

  return {
    data,
    set: (field, value) => setData((current) => ({ ...current, [field]: value })),
    setData,
    errors,
    hasErrors: Object.keys(errors).length > 0,
    clearErrors: (...fields) =>
      setErrors((current) =>
        fields.length === 0 ? {} : (Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as Field<T>))) as typeof current),
      ),
    processing,
    wasSuccessful,
    recentlySuccessful,
    isDirty: JSON.stringify(data) !== JSON.stringify(defaults),
    reset: (...fields) => {
      if (fields.length === 0) setData(defaults);
      else setData((current) => ({ ...current, ...Object.fromEntries(fields.map((field) => [field, defaults[field as keyof typeof defaults]])) }));
    },
    submit,
    get: (url, options) => submit('get', url, options),
    post: (url, options) => submit('post', url, options),
    put: (url, options) => submit('put', url, options),
    patch: (url, options) => submit('patch', url, options),
    delete: (url, options) => submit('delete', url, options),
  };
}

/** Server errors are lists per field; forms show the first. */
function firstMessages(errors: unknown): Record<string, string> {
  if (typeof errors !== 'object' || errors === null) return {};
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (typeof first === 'string') result[field] = first;
  }
  return result;
}
