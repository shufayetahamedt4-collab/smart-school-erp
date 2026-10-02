/**
 * The grounded assistant — types.
 *
 * Everything the assistant says or does is derived from the school's OWN data
 * through the existing session/scope helpers. There is no external model, no API
 * key and no network egress: `intents.ts` parses the question, `tools.ts` reads
 * the (already role-scoped) records, and `respond.ts` turns the result into a
 * short answer plus optional cards and a confirm-to-act descriptor.
 */

export type AssistantRole = "TEACHER" | "GUARDIAN";

/** A parsed request. Slots are optional; the tools fall back sensibly. */
export type Intent =
  | { kind: "attendance.summary"; date?: string }
  | { kind: "homework.list" }
  | { kind: "homework.create"; title?: string; subject?: string; dueDate?: string }
  | { kind: "marks.lookup"; name?: string }
  | { kind: "fees.due" }
  | { kind: "notices.list" }
  | { kind: "classes.list" }
  | { kind: "help" }
  | { kind: "unknown" };

/** One line of a results card. */
export interface AssistantRow {
  label: string;
  value: string;
  /** Presentation hint only — the client maps it to a colour. */
  tone?: "default" | "good" | "warn" | "bad";
}

/** A structured answer block rendered under the assistant's text. */
export interface AssistantCard {
  title?: string;
  rows: AssistantRow[];
}

/**
 * A proposed write. The assistant NEVER performs a write itself: it returns this
 * descriptor and the UI shows a confirmation card. Confirming calls the EXISTING
 * endpoint unchanged, so every validation, permission and audit the portal
 * already applies still applies.
 */
export interface AssistantAction {
  /** Short verb for the confirm button. */
  label: string;
  /** What will change, in one sentence, for the user to approve. */
  summary: string;
  endpoint: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body: Record<string, unknown>;
  /** For the client: what to say once it succeeds. */
  success: string;
}

export interface AssistantReply {
  answer: string;
  cards?: AssistantCard[];
  action?: AssistantAction;
}

export interface AssistantRequest {
  message: string;
}
