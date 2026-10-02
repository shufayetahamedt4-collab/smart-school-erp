"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, SendHorizontal, Sparkles, TriangleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { suggestionsFor } from "@/lib/assistant/intents";
import type { AssistantAction, AssistantCard, AssistantReply } from "@/lib/assistant/types";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards?: AssistantCard[];
  action?: AssistantAction;
}

let seq = 0;
const nextId = () => `m${++seq}`;

/**
 * The assistant conversation.
 *
 * Presentation + a single POST to `/api/assistant`. A reply may carry cards
 * (rendered as a small table) and an `action` — a PROPOSED write. Nothing is
 * written until the user taps Confirm, and confirming calls the action's own
 * EXISTING endpoint, so the portal's validation/permission/audit all still run.
 */
export function AssistantPanel({ role, appearance = "default" }: { role: "TEACHER" | "GUARDIAN"; appearance?: "default" | "teacher" | "guardian" }) {
  // Presentation only: the Teacher App already names this screen in its dark app
  // bar, so the panel drops its duplicate heading there. Nothing about the reads,
  // the intents, the responses or the confirm-to-write flow changes.
  // Both phone-first apps (Teacher, Parents) share the app presentation: the dark
  // app bar is the title, and the controls are real touch targets.
  const teacher = appearance === "teacher" || appearance === "guardian";
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const chips = suggestionsFor(role);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setMessages((m) => [...m, { id: nextId(), role: "user", text: message }]);
    setBusy(true);
    try {
      const reply = await api<AssistantReply>("/api/assistant", {
        method: "POST",
        body: JSON.stringify({ message }),
        cache: "no-store",
      });
      setMessages((m) => [...m, { id: nextId(), role: "assistant", text: reply.answer, cards: reply.cards, action: reply.action }]);
    } catch (e: any) {
      setMessages((m) => [...m, { id: nextId(), role: "assistant", text: e?.message || "Something went wrong. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(msgId: string, action: AssistantAction) {
    setConfirmingId(msgId);
    try {
      await api(action.endpoint, { method: action.method, body: JSON.stringify(action.body) });
      setMessages((m) => [
        ...m.map((msg) => (msg.id === msgId ? { ...msg, action: undefined } : msg)),
        { id: nextId(), role: "assistant", text: `✅ ${action.success}` },
      ]);
    } catch (e: any) {
      setMessages((m) => [
        ...m.map((msg) => (msg.id === msgId ? { ...msg, action: undefined } : msg)),
        { id: nextId(), role: "assistant", text: `I couldn't do that: ${e?.message || "request failed"}.` },
      ]);
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col">
      {/* Both apps: the app bar is the title, so the panel does not repeat it. */}
      {!teacher && (
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-600/20">
            <Sparkles size={20} />
          </span>
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-900">AI Assistant</h1>
            <p className="text-xs text-slate-500">Answers from your school&apos;s data — nothing leaves this server.</p>
          </div>
        </div>
      )}

      <div className={cn("flex-1 space-y-3", !teacher && "mt-4")}>
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void send(c)}
                // The Teacher app's touch minimum: a suggestion chip is the first
                // thing a thumb reaches for, so it is a real 44px target there.
                className={cn(
                  "rounded-full border border-slate-200 bg-white px-3.5 py-2 text-left text-[13px] font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50",
                  teacher && "min-h-11"
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[92%] space-y-2", msg.role === "user" && "max-w-[85%]")}>
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed shadow-sm",
                  msg.role === "user"
                    ? "brand-bg text-white"
                    : "border border-slate-200 bg-white text-slate-700"
                )}
              >
                {msg.text}
              </div>

              {msg.cards?.map((card, ci) => (
                <CardView key={ci} card={card} />
              ))}

              {msg.action && (
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3.5">
                  <div className="flex items-start gap-2">
                    <TriangleAlert size={15} className="mt-0.5 shrink-0 text-indigo-500" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-indigo-900">Confirm before I do this</p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-indigo-800/80">{msg.action.summary}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={confirmingId === msg.id}
                    onClick={() => void confirm(msg.id, msg.action!)}
                    className={cn("btn btn-primary mt-3 w-full !py-2.5 disabled:opacity-60", teacher && "min-h-11")}
                  >
                    {confirmingId === msg.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {msg.action.label}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 text-[13px] text-slate-400 shadow-sm">
              <Loader2 size={15} className="animate-spin" /> Thinking…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="sticky bottom-2 mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg shadow-slate-900/5"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about attendance, homework, results…"
          aria-label="Ask the assistant"
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] text-slate-800 outline-none placeholder:text-slate-400",
            teacher && "min-h-11"
          )}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className={cn("btn btn-primary shrink-0 !px-4 !py-2.5 disabled:opacity-50", teacher && "min-h-11")}
          aria-label="Send"
        >
          <SendHorizontal size={17} />
        </button>
      </form>
    </div>
  );
}

function CardView({ card }: { card: AssistantCard }) {
  const toneClass: Record<string, string> = {
    default: "text-slate-700",
    good: "text-emerald-600",
    warn: "text-amber-600",
    bad: "text-rose-600",
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {card.title && (
        <div className="border-b border-slate-100 px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
          {card.title}
        </div>
      )}
      <div className="divide-y divide-slate-50">
        {card.rows.map((row, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-3.5 py-2">
            <span className="min-w-0 truncate text-[13px] text-slate-600">{row.label}</span>
            <span className={cn("shrink-0 text-[13px] font-semibold", toneClass[row.tone || "default"])}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
