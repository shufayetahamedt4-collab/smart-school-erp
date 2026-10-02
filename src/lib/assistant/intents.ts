import type { AssistantRole, Intent } from "./types";

/**
 * Deterministic intent parsing.
 *
 * This is deliberately NOT a language model: a small, readable set of keyword
 * rules maps a question onto one of a fixed set of grounded actions. That keeps
 * the assistant predictable, auditable and free, and it can never invent data —
 * an unrecognised question gets an honest "here's what I can do" instead.
 */

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Pull a date out of the message ("today", "yesterday", or an ISO date). */
function extractDate(text: string): string | undefined {
  if (/\byesterday\b/.test(text)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return isoDate(d);
  }
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  if (/\btoday\b/.test(text)) return isoDate(new Date());
  return undefined;
}

/** A student name after "for", "of", or "about" ("marks for Ayesha Rahman"). */
function extractName(raw: string): string | undefined {
  const m = /\b(?:for|of|about)\s+([A-Za-z][A-Za-z .'-]{1,40})/i.exec(raw);
  return m ? m[1].trim().replace(/[?.!]+$/, "") : undefined;
}

/** A short homework title from a "create homework …" instruction. */
function extractHomeworkTitle(raw: string): string | undefined {
  const afterColon = /homework\s*[:\-]\s*(.+)$/i.exec(raw);
  if (afterColon) return afterColon[1].trim();
  const afterVerb = /(?:create|assign|add|post|give)\s+homework\s+(?:on\s+|about\s+|for\s+)?(.+)$/i.exec(raw);
  if (afterVerb) return afterVerb[1].trim();
  return undefined;
}

const SUBJECTS = [
  "maths", "math", "english", "science", "bangla", "bengali", "physics", "chemistry",
  "biology", "history", "geography", "ict", "religion", "arabic",
];

export function parseIntent(raw: string): Intent {
  const text = (raw || "").trim();
  const t = text.toLowerCase();
  if (!t) return { kind: "unknown" };

  const has = (...words: string[]) => words.some((w) => t.includes(w));

  if (/^(help|hi|hello|hey)\b/.test(t) || has("what can you do", "what can i ask", "how can you help")) {
    return { kind: "help" };
  }

  // Write intent first, so "create homework" never falls through to the list.
  if (has("create homework", "assign homework", "add homework", "new homework", "post homework", "give homework", "set homework")) {
    const subject = SUBJECTS.find((s) => t.includes(s));
    return {
      kind: "homework.create",
      title: extractHomeworkTitle(text),
      subject: subject ? subject.charAt(0).toUpperCase() + subject.slice(1) : undefined,
      dueDate: extractDate(t),
    };
  }

  if (has("homework", "assignment", "classwork", "class work")) return { kind: "homework.list" };

  if (has("absent", "attendance", "present", "who is in", "who's in", "who is here")) {
    return { kind: "attendance.summary", date: extractDate(t) };
  }

  if (has("marks", "result", "results", "grade", "grades", "score", "scores", "gpa")) {
    return { kind: "marks.lookup", name: extractName(text) };
  }

  if (has("fee", "fees", "dues", "due", "payment", "payments", "bill", "outstanding")) {
    return { kind: "fees.due" };
  }

  if (has("notice", "notices", "announcement", "announcements", "circular", "event")) {
    return { kind: "notices.list" };
  }

  if (has("my class", "my classes", "classes", "timetable", "routine", "roster")) {
    return { kind: "classes.list" };
  }

  return { kind: "unknown" };
}

/** The example questions offered as chips, per role. */
export function suggestionsFor(role: AssistantRole): string[] {
  if (role === "TEACHER") {
    return [
      "Who is absent today?",
      "Show my classes",
      "What homework is set?",
      "Create homework: Fractions worksheet, due tomorrow",
      "Show the latest notices",
    ];
  }
  return [
    "How is my child's attendance?",
    "What homework is pending?",
    "Show my child's results",
    "Are there any fees due?",
    "Show the latest notices",
  ];
}
