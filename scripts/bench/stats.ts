/**
 * Welch's t-test for `pnpm bench`: is the mean of `a` different from the mean of `b` (unequal variances)? Returns the relative
 * difference of the means (`mean(a) / mean(b) − 1`), its 95 % confidence interval and the two-sided p-value.
 */
export function welch(a: readonly number[], b: readonly number[]): { relative: number; ciLow: number; ciHigh: number; p: number } {
  const [ma, va] = meanAndVariance(a);
  const [mb, vb] = meanAndVariance(b);
  const sa = va / a.length;
  const sb = vb / b.length;
  const se = Math.sqrt(sa + sb);
  const df = (sa + sb) ** 2 / (sa ** 2 / (a.length - 1) + sb ** 2 / (b.length - 1));
  const difference = ma - mb;
  if (se === 0) return { relative: difference / mb, ciLow: difference / mb, ciHigh: difference / mb, p: difference === 0 ? 1 : 0 };
  const t = difference / se;
  const p = incompleteBeta(df / (df + t * t), df / 2, 0.5);
  const q = studentQuantile(0.975, df);
  return { relative: difference / mb, ciLow: (difference - q * se) / mb, ciHigh: (difference + q * se) / mb, p };
}

function meanAndVariance(values: readonly number[]): [number, number] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return [mean, variance];
}

/** The `p` quantile of Student's t with `df` degrees of freedom (p > 0.5), by bisection on its distribution function. */
function studentQuantile(p: number, df: number): number {
  let low = 0;
  let high = 1000;
  for (let i = 0; i < 100; i++) {
    const t = (low + high) / 2;
    const cdf = 1 - incompleteBeta(df / (df + t * t), df / 2, 0.5) / 2;
    if (cdf < p) low = t;
    else high = t;
  }
  return (low + high) / 2;
}

/** The regularized incomplete beta function I_x(a, b) (continued fraction, Numerical Recipes' `betacf`). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * continuedFraction(x, a, b)) / a : 1 - (front * continuedFraction(1 - x, b, a)) / b;
}

function continuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-12) break;
  }
  return h;
}

/** ln Γ(x), Lanczos approximation. */
function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of g) series += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}
