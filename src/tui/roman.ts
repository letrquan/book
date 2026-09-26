/**
 * A number the way a book prints it in its front matter: `i`, `iv`, `xii`.
 * Zero and negative numbers have no numeral.
 */
export function romanNumeral(value: number): string {
  let n = Math.floor(value);
  if (n <= 0) return '';
  const steps: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [step, numeral] of steps) {
    while (n >= step) {
      out += numeral;
      n -= step;
    }
  }
  return out;
}
