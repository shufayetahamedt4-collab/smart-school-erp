import AdmissionIntakeForm from "@/components/AdmissionIntakeForm";

/**
 * Admissions module — "New admission" (`/dashboard/admissions/new`).
 *
 * PRD §4.2: exactly the same form with exactly the same information fields as the
 * Students module's "New Admission" — because it *is* the same form
 * (`@/components/AdmissionIntakeForm`; only the back links differ).
 *
 * One submit writes the student, the guardian's login, the family link, the
 * admission + monthly fee, the discount, the money taken at the counter and the
 * books/uniform/ID card, and files the record in this pipeline as ENROLLED —
 * unless something could not be finished (kit out of stock, a discount awaiting
 * approval, a fee left unpaid), which comes back as a visible to-do list.
 *
 * An applicant who is still only at the enquiry stage (no seat, no fee, no
 * enrollment) stays with the desk's "Quick enquiry" button on the list page.
 */
export default function NewAdmissionPage() {
  return (
    <AdmissionIntakeForm
      cancelHref="/dashboard/admissions"
      cancelLabel="Admissions"
      successHref="/dashboard/admissions"
      successLabel="Admissions pipeline"
    />
  );
}
