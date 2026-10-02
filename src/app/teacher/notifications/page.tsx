"use client";

import { NotificationsCenter } from "@/components/NotificationsCenter";

/**
 * Teacher → Notifications.
 *
 * The dark app bar already names this screen, so the old `PageHeader` (which
 * repeated "Notifications" under it) is gone. The centre itself is unchanged in
 * every functional respect — same reads, filters, mark read/unread, delete and
 * clear-read calls — and only asked for its Teacher surface presentation.
 */
export default function NotificationsPage() {
  return (
    <div className="ss-notifpage">
      <NotificationsCenter appearance="teacher" />
    </div>
  );
}
