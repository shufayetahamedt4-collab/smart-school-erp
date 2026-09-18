"use client";

import { PageHeader } from "@/components/ui";
import { ChatPanel } from "@/components/ChatPanel";

export default function ParentMessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Live chat with your child's teachers (PRD §7.1 two-way chat)" />
      <ChatPanel />
    </div>
  );
}
