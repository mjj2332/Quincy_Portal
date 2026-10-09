/** An exact rate or duration, e.g. 30000/1001 fps. Always reduced, with den > 0 and both safe integers. */
export type Rational = Readonly<{ num: number; den: number }>;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** Builds a reduced Rational. Throws on a zero or negative denominator or a non-integer part. */
export function rational(num: number, den: number): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new RangeError(`invalid rational ${num}/${den}`);
  }
  const g = gcd(num, den) || 1;
  return Object.freeze({ num: num / g, den: den / g });
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}
