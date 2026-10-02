"use client";

import { ChatPanel } from "@/components/ChatPanel";

/**
 * Teacher → Messages.
 *
 * The dark app bar already names this screen, so the old `PageHeader` is gone.
 * The panel keeps every conversation route, send and unread behaviour exactly as
 * it was and only takes its Teacher surface presentation.
 */
export default function TeacherMessagesPage() {
  return (
    <div className="ss-messagespage">
      <ChatPanel appearance="teacher" />
    </div>
  );
}
