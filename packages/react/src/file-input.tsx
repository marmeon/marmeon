import { loadUploads } from '@marmeon/http/client/adapter';
import type { Upload } from '@marmeon/http/page';
import { useCallback, useEffect, useRef, type InputHTMLAttributes } from 'react';
import { useRouterContext } from './app.tsx';
import type { FormField } from './use-form.ts';

/**
 * Uploads `file` for an upload field — what `<FileInput>` does when a file is chosen, for a drop zone or a cropped
 * image of your own: `const send = useUpload(form.field('avatar'))`, then `send(file)`. The field's value becomes the
 * {@link Upload}; a file chosen while one is on its way replaces it. See docs/forms.md#uploads.
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

/** The props of {@link FileInput}: the upload `field` of a route form, plus the attributes of an `<input>`. */
export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'multiple' | 'name'> {
  /** The upload field of a route form: `form.field('avatar')` (its rule is `upload()`). */
  readonly field: FormField;
  /** After a file was chosen (its upload has started). */
  readonly onChange?: (file: File) => void;
}

/**
 * A file input for an upload field: a chosen file is uploaded at once, and the field holds the
 * {@link Upload} (`progress`, `preview`, `error`, `cancel()`). The form then sends the token, never the file. A file still on
 * its way when the input goes is cancelled. See docs/forms.md#uploads.
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
