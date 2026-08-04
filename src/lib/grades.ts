export interface GradeInfo {
  grade: string;
  gpa: number;
}

/** Bangladesh-style grading scale (configurable full marks). */
export function gradeFor(obtained: number, full = 100): GradeInfo {
  const pct = (obtained / full) * 100;
  if (pct >= 80) return { grade: "A+", gpa: 5.0 };
  if (pct >= 70) return { grade: "A", gpa: 4.0 };
  if (pct >= 60) return { grade: "A-", gpa: 3.5 };
  if (pct >= 50) return { grade: "B", gpa: 3.0 };
  if (pct >= 40) return { grade: "C", gpa: 2.0 };
  if (pct >= 33) return { grade: "D", gpa: 1.0 };
  return { grade: "F", gpa: 0.0 };
}

export function gpaOf(points: number[]): number {
  if (!points.length) return 0;
  const sum = points.reduce((a, b) => a + b, 0);
  return Math.round((sum / points.length) * 100) / 100;
}

export function totalOf(marks: number[]): number {
  return marks.reduce((a, b) => a + b, 0);
}

/** Returns 1-based positions ranked by total marks. */
export function positions(totals: number[]): Map<number, number> {
  const sorted = [...totals].sort((a, b) => b - a);
  const map = new Map<number, number>();
  sorted.forEach((t, i) => {
    if (!map.has(t)) map.set(t, i + 1);
  });
  return map;
}
