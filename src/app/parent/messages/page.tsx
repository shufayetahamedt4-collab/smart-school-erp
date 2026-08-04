"use client";

import { PageHeader } from "@/components/ui";
import { MessagesPanel } from "@/components/MessagesPanel";

export default function ParentMessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Chat with your child's teachers" />
      <MessagesPanel />
    </div>
  );
}
