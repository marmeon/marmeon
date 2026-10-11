/**
 * The mark: an incised M on a square. Colours come from the stylesheet (`--fg` and `--bg`), so it inverts with the theme. Below
 * 24 px the stroke is 2 and the coordinates sit on whole pixels.
 */
export function Mark({ size = 24 }: { size?: 16 | 24 }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect className="mark-plate" width="16" height="16" rx="1.5" />
      <path className="mark-groove" d={size === 16 ? 'M4 12.5V4.5L8 9.5l4-5v8' : 'M4 12V4.2L8 9.2l4-5V12'} strokeWidth={size === 16 ? 2 : 1.6} />
    </svg>
  );
}
