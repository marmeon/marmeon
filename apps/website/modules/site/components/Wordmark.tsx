import { Mark } from './Mark.tsx';

/**
 * The mark and the name in capitals. `small` is the footer's size: a 20 px mark and a tighter gap.
 */
export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? 'wordmark wordmark--small' : 'wordmark'}>
      <Mark size={24} />
      <span className="wordmark-name">MARMEON</span>
    </span>
  );
}
