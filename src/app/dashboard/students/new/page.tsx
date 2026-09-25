import AdmissionIntakeForm from "@/components/AdmissionIntakeForm";

/**
 * Students module — "New Admission" (`/dashboard/students/new`).
 *
 * The form itself is the shared intake form (`@/components/AdmissionIntakeForm`) —
 * the very same component the Admissions module renders at
 * `/dashboard/admissions/new`. One component on purpose: the two entry points must
 * never offer a different set of information fields.
 */
export default function NewStudentPage() {
  return <AdmissionIntakeForm />;
}
