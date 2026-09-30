"use client";

import { PageHeader } from "@/components/ui";
import { NotificationsCenter } from "@/components/NotificationsCenter";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Platform events — new schools registering, plan changes and billing activity across every tenant."
      />
      <NotificationsCenter />
    </div>
  );
}
