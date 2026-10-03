import { loadUploads } from '@bespokecore/http/client';
import type { Upload } from '@bespokecore/http/page';
import { useCallback, useEffect, useRef, type InputHTMLAttributes } from 'react';
import { useRouterContext } from './app.tsx';
import type { FormField } from './use-form.ts';

/**
 * Uploads `file` for an upload field (W6.9) — what `<FileInput>` does when a file is chosen, for a drop zone or a cropped
 * image of your own: `const send = useUpload(form.field('avatar'))`, then `send(file)`. The field's value becomes the
 * {@link Upload} at once (`uploading`, `progress`, `preview`), then follows it until the file arrived (its token is what the
 * form sends) or failed (`error`). A file chosen while one is on its way replaces it. The uploads' code loads on first use.
 */
export function useUpload(field: FormField): (file: File) => Promise<void> {
  const navigator = useRouterContext().navigator();
  const { form, name } = field;
  return useCallback(
    async (file: File) => {
      if (!navigator) return; // no uploads while rendering on the server
      const feature = await navigator.load(loadUploads);
      (form.data[name] as Upload | null | undefined)?.cancel?.();
      form.set(name, feature.start({ method: form.method, url: form.url, field: name, file, onChange: (upload) => form.set(name, upload) }));
    },
    [navigator, form, name],
  );
}

export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'multiple' | 'name'> {
  /** The upload field of a route form: `form.field('avatar')` (its rule is `upload()`). */
  readonly field: FormField;
  /** After a file was chosen (its upload has started). */
  readonly onChange?: (file: File) => void;
}

/**
 * A file input for an upload field (W6.9, Livewire's model): a chosen file is uploaded at once — to a target the form's
 * route hands out for the field — and the field holds the {@link Upload}: show `form.data.avatar?.progress`, its `preview`
 * (`blob:`), its `error`, and `cancel()` it; `form.data.avatar?.uploading` while it is on its way. The form then sends the
 * token, never the file — checked on the server by size and by its bytes.
 *
 * ```tsx
 * const form = useForm('user-profile.avatar.update', { user: me.id }, { avatar: null });
 * <FileInput field={form.field('avatar')} accept="image/png,image/jpeg,image/webp" />
 * {form.data.avatar?.uploading && <progress value={form.data.avatar.progress} max={1} />}
 * ```
 *
 * The uploads' code loads when the input renders (E74). A file still on its way when the input goes is cancelled.
 */
export function FileInput({ field, onChange, ...attributes }: FileInputProps) {
  const navigator = useRouterContext().navigator();
  const send = useUpload(field);
  const element = useRef<HTMLInputElement>(null);
  const value = field.form.data[field.name] as Upload | null | undefined;
  const current = useRef(value);
  current.current = value;

  // Fetch the code while the input is on screen — before anyone chooses a file.
  useEffect(() => void navigator?.load(loadUploads).catch(() => undefined), [navigator]);
  // Cancelled or sent (the field is empty again): the input forgets its file, so choosing the same one again uploads it.
  useEffect(() => {
    if (!value && element.current) element.current.value = '';
  }, [value]);
  // An upload still on its way when the input goes is not finished for nobody.
  useEffect(() => () => void (current.current?.uploading && current.current.cancel()), []);

  return (
    <input
      {...attributes}
      ref={element}
      type="file"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        void send(file);
        onChange?.(file);
      }}
    />
  );
}
