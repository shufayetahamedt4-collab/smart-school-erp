"use client";

import { PageHeader } from "@/components/ui";
import { MessagesPanel } from "@/components/MessagesPanel";

export default function TeacherMessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Chat with guardians of your students" />
      <MessagesPanel />
    </div>
  );
}
