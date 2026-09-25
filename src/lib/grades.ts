/**
 * Ranking helpers — deliberately NOT grading policy.
 *
 * The letter/GPA scale used to be hardcoded here. It now lives in
 * `src/lib/grading.ts` as the school's own editable scheme (bands, grade
 * points, pass mark, GPA scale), so no grade is decided in this file: keeping
 * two scales would let a report card disagree with a marks sheet.
 */

export function totalOf(marks: number[]): number {
  return marks.reduce((a, b) => a + b, 0);
}

/** Returns 1-based positions ranked by total marks (ties share a position). */
export function positions(totals: number[]): Map<number, number> {
  const sorted = [...totals].sort((a, b) => b - a);
  const map = new Map<number, number>();
  sorted.forEach((t, i) => {
    if (!map.has(t)) map.set(t, i + 1);
  });
  return map;
}
