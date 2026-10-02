import { AssistantPanel } from "@/components/assistant/AssistantPanel";

/**
 * Teacher → AI Assistant.
 *
 * Grounded, read-only, and unchanged: the same `/api/assistant` call, the same
 * intents, tools and responses, the same confirm-to-write flow for a homework
 * draft. The only change is that the panel does not repeat the heading the dark
 * app bar already shows.
 */
export default function TeacherAiPage() {
  return <AssistantPanel role="TEACHER" appearance="teacher" />;
}