"use client";

import { ChatPanel } from "@/components/ChatPanel";

/**
 * Guardian → Messages.
 *
 * The app bar already names this screen, so the old `PageHeader` is gone. The
 * panel keeps every conversation route, send and unread behaviour exactly as it
 * was and only takes the app-surface presentation.
 */
export default function ParentMessagesPage() {
  return (
    <div>
      <ChatPanel appearance="guardian" />
    </div>
  );
}
