import { AssistantPanel } from "@/components/assistant/AssistantPanel";

/**
 * Guardian → AI Assistant.
 *
 * The dark app bar already names this screen, so the panel takes the app
 * presentation — the same one the Teacher App asks for — and does not repeat the
 * heading. Grounded, read-only and unchanged otherwise: the same `/api/assistant`
 * call, the same intents, tools and responses for the guardian's own child.
 */
export default function ParentAiPage() {
  return <AssistantPanel role="GUARDIAN" appearance="guardian" />;
}
