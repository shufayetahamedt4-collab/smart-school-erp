"use client";

import { PageHeader } from "@/components/ui";
import { ChatPanel } from "@/components/ChatPanel";

export default function TeacherMessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Live chat with guardians (PRD §7.1 two-way chat)" />
      <ChatPanel />
    </div>
  );
}
