/**
 * How far apart two servers' clocks may be before a time written by one is refused by the other, in seconds. It lets a window accept
 * a timestamp this far in the future and no further; it never lengthens how long a past one stays valid.
 */
export const CLOCK_SKEW_SECONDS = 60;
