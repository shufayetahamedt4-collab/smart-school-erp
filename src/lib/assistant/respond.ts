import type { SessionUser } from "@/lib/auth";
import { parseIntent } from "./intents";
import {
  firstClassForTeacher,
  guardianAttendance,
  guardianFees,
  guardianHomework,
  guardianMarks,
  latestNotices,
  subjectIdByName,
  teacherAttendance,
  teacherClasses,
  teacherHomework,
  teacherMarks,
} from "./tools";
import type { AssistantAction, AssistantCard, AssistantReply } from "./types";

/**
 * Turn a parsed intent into a grounded reply.
 *
 * Reads go through `tools.ts` (role-scoped). Writes are only ever PROPOSED: the
 * reply carries an `action` descriptor and the UI must confirm it, at which
 * point the client calls the existing endpoint unchanged.
 */

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function help(): AssistantReply {
  return {
    answer:
      "I answer from your school's own data — no outside service, nothing leaves this server. Ask me about attendance, homework, results, fees or notices, or tell me to create homework and I'll ask you to confirm first.",
    cards: [
      {
        title: "Things you can ask",
        rows: [
          { label: "Who is absent today?", value: "Attendance" },
          { label: "Show my classes", value: "Classes" },
          { label: "Show the latest notices", value: "Notices" },
          { label: "Create homework: …", value: "I'll confirm first" },
        ],
      },
    ],
  };
}

export async function respond(session: SessionUser, message: string): Promise<AssistantReply> {
  const intent = parseIntent(message);
  const isTeacher = session.role === "TEACHER";

  switch (intent.kind) {
    case "help":
      return help();

    case "attendance.summary": {
      if (isTeacher) {
        const s = await teacherAttendance(session, intent.date);
        const cards: AssistantCard[] = [
          {
            title: `Attendance · ${fmtDate(s.date)}`,
            rows: [
              { label: "Present", value: String(s.counts.PRESENT), tone: "good" },
              { label: "Absent", value: String(s.counts.ABSENT), tone: s.counts.ABSENT ? "bad" : "default" },
              { label: "Late", value: String(s.counts.LATE), tone: s.counts.LATE ? "warn" : "default" },
              { label: "Marked", value: `${s.marked} of ${s.total}` },
            ],
          },
        ];
        if (s.absentees.length) {
          cards.push({
            title: "Absent",
            rows: s.absentees.slice(0, 8).map((a) => ({ label: a.name, value: a.className || "—", tone: "bad" as const })),
          });
        }
        return {
          answer: `${s.counts.ABSENT} absent and ${s.counts.PRESENT} present of ${s.total} students on ${fmtDate(s.date)} (${s.marked} marked).`,
          cards,
        };
      }
      const s = await guardianAttendance(session);
      if (!s.childName) return { answer: "I couldn't find a linked child on this account." };
      return {
        answer: `${s.childName}: ${s.counts.PRESENT} present, ${s.counts.ABSENT} absent, ${s.counts.LATE} late across the last ${s.total} recorded days.`,
        cards: [
          {
            title: "Recent attendance",
            rows: s.recent.map((r) => ({
              label: fmtDate(r.date),
              value: r.status.replace("_", " ").toLowerCase(),
              tone: r.status === "ABSENT" ? "bad" : r.status === "PRESENT" ? "good" : "warn",
            })),
          },
        ],
      };
    }

    case "homework.list": {
      if (isTeacher) {
        const items = await teacherHomework(session);
        if (!items.length) return { answer: "No homework found. You can create some by typing “Create homework: …”." };
        return {
          answer: `${items.length} recent homework item(s).`,
          cards: [{ title: "Homework", rows: items.map((h) => ({ label: h.title, value: [h.subject, h.className].filter(Boolean).join(" · ") })) }],
        };
      }
      const { childName, items } = await guardianHomework(session);
      if (!childName) return { answer: "I couldn't find a linked child on this account." };
      if (!items.length) return { answer: `${childName} has no homework set right now.` };
      return {
        answer: `${items.length} homework item(s) for ${childName}.`,
        cards: [{ title: "Homework", rows: items.map((h) => ({ label: h.title, value: h.due ? `due ${fmtDate(h.due)}` : h.subject })) }],
      };
    }

    case "homework.create": {
      if (!isTeacher) return { answer: "Only teachers can create homework." };
      const classId = await firstClassForTeacher(session);
      if (!classId) return { answer: "I couldn't find a class to attach this to yet." };
      const subjectId = await subjectIdByName(session, intent.subject);
      const title = intent.title || "New homework";
      const dueDate = intent.dueDate || new Date().toISOString().slice(0, 10);
      const action: AssistantAction = {
        label: "Create homework",
        summary: `Post “${title}”${intent.subject ? ` (${intent.subject})` : ""} to your class, due ${fmtDate(dueDate)}. Guardians will be notified.`,
        endpoint: "/api/homework",
        method: "POST",
        body: { classId, subjectId, title, dueDate },
        success: `Homework “${title}” posted.`,
      };
      return { answer: "I can post that for you — confirm below and I'll create it.", action };
    }

    case "marks.lookup": {
      if (isTeacher) {
        if (!intent.name) return { answer: "Which student? Ask again with a name, e.g. “marks for Ayesha Rahman”." };
        const r = await teacherMarks(session, intent.name);
        if (!r) return { answer: `I couldn't find a student matching “${intent.name}”.` };
        if (!r.items.length) return { answer: `${r.studentName} has no marks recorded yet.` };
        return {
          answer: `${r.studentName}: ${r.items.length} recent mark(s).`,
          cards: [{ title: r.studentName, rows: r.items.map((m) => ({ label: m.subject, value: `${m.obtained}${m.grade ? ` · ${m.grade}` : ""}` })) }],
        };
      }
      const { childName, items } = await guardianMarks(session);
      if (!childName) return { answer: "I couldn't find a linked child on this account." };
      if (!items.length) return { answer: `${childName} has no results recorded yet.` };
      return {
        answer: `${childName}: ${items.length} recent mark(s).`,
        cards: [{ title: childName, rows: items.map((m) => ({ label: m.subject, value: `${m.obtained}${m.grade ? ` · ${m.grade}` : ""}` })) }],
      };
    }

    case "fees.due": {
      if (isTeacher) return { answer: "Fees are shown in the Parents App — ask there from a guardian account." };
      const { childName, due, outstanding } = await guardianFees(session);
      if (!childName) return { answer: "I couldn't find a linked child on this account." };
      if (!due.length) return { answer: `${childName} has no outstanding fees. 🎉` };
      return {
        answer: `${childName} has ${due.length} unpaid item(s) totalling ${outstanding}.`,
        cards: [{ title: "Fees due", rows: due.map((f) => ({ label: f.label, value: `${f.amount} · ${f.status.toLowerCase()}`, tone: "warn" as const })) }],
      };
    }

    case "classes.list": {
      if (!isTeacher) return { answer: "Class lists are for teachers. Your child's class shows on the Home tab." };
      const classes = await teacherClasses(session);
      if (!classes.length) return { answer: "No classes found for your school yet." };
      return {
        answer: `${classes.length} class(es) in your school.`,
        cards: [{ title: "Classes", rows: classes.map((c) => ({ label: c.name, value: `${c.students} students` })) }],
      };
    }

    case "notices.list": {
      const notices = await latestNotices(session);
      if (!notices.length) return { answer: "No notices have been posted yet." };
      return {
        answer: `The ${notices.length} latest notice(s).`,
        cards: [{ title: "Notices", rows: notices.map((n) => ({ label: n.title, value: `${n.category.toLowerCase()} · ${fmtDate(n.date)}` })) }],
      };
    }

    default:
      return {
        answer: "I'm not sure how to answer that yet. Here's what I can do from your school's data.",
        cards: help().cards,
      };
  }
}
