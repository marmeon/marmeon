import { Mark } from './Mark.tsx';

/**
 * The mark and the name in capitals; `suffix` adds a second word in the mono face ("docs"). `small` is the footer's size: a 20 px
 * mark and a tighter gap.
 */
export function Wordmark({ suffix, small = false }: { suffix?: string; small?: boolean }) {
  return (
    <span className={small ? 'wordmark wordmark--small' : 'wordmark'}>
      <Mark size={24} />
      <span className="wordmark-name">MARMEON</span>
      {suffix && <span className="wordmark-suffix">{suffix}</span>}
    </span>
  );
}
