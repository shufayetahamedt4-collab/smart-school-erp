"use client";

import { PageHeader } from "@/components/ui";
import { NotificationsCenter } from "@/components/NotificationsCenter";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Everything addressed to the office — new notices, admissions, leave decisions, payments and staff activity."
      />
      <NotificationsCenter />
    </div>
  );
}
