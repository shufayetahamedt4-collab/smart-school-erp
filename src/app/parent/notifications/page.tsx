"use client";

import { PageHeader } from "@/components/ui";
import { NotificationsCenter } from "@/components/NotificationsCenter";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Attendance, homework, results, fees and notices for your child — as they happen."
      />
      <NotificationsCenter />
    </div>
  );
}
