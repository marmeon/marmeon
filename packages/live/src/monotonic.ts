/**
 * Milliseconds on a clock that never steps back inside this process (epoch-shaped, but not the wall clock: NTP or an operator
 * moving the wall clock does not move it). For ordering two events of one process only.
 */
export const monotonicNow = (): number => performance.timeOrigin + performance.now();
