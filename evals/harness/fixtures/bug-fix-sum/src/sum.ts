export function sum(values: number[]): number {
  return values.slice(1).reduce((total, value) => total + value, 0);
}
