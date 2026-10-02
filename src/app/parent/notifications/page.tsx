"use client";

import { NotificationsCenter } from "@/components/NotificationsCenter";

/**
 * Guardian → Notifications.
 *
 * The app bar already names this screen, so the old `PageHeader` is gone. The
 * centre keeps every functional behaviour (same reads, filters, mark
 * read/unread, delete, clear-read) and only takes the app-surface presentation,
 * now shared by both phone-first apps.
 */
export default function ParentNotificationsPage() {
  return (
    <div className="ss-notifpage">
      <NotificationsCenter appearance="guardian" />
    </div>
  );
}
