"use client";

import { PageHeader } from "@/components/ui";
import { MessagesPanel } from "@/components/MessagesPanel";

export default function AdminMessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Parent–teacher communication" />
      <MessagesPanel />
    </div>
  );
}
