"use client";

import { PageHeader } from "@/components/ui";
import { NotificationsCenter } from "@/components/NotificationsCenter";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Notices, leave decisions, PTM bookings and messages from the office and your families."
      />
      <NotificationsCenter />
    </div>
  );
}
