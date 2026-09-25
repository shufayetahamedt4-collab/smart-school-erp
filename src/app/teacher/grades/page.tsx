"use client";

import GradingSchemeEditor from "@/components/GradingSchemeEditor";

/**
 * Teacher app → Grading & GPA.
 *
 * The same editor the School Admin console uses. Marks entry is the teacher's
 * job, so the scale those marks are graded against is theirs to keep right too
 * (the server allows admins and teachers to write; guardians only to read).
 */
export default function TeacherGradesPage() {
  return <GradingSchemeEditor />;
}
