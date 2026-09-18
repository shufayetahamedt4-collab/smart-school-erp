"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, MessageSquare, ArrowLeft, Search } from "lucide-react";
import { api } from "@/lib/client";
import { Card, EmptyState, LoadingScreen, ErrorNote, Spinner } from "@/components/ui";
import { fmtDate, initials, cn } from "@/lib/utils";
import { useMe } from "./Shell";

/**
 * PRD §7.1/§13 — Two-way Live Chat (Teacher ↔ Guardian).
 * Conversation list + thread view with polling refresh; replaces the
 * one-shot broadcast messaging for real conversations.
 */

interface ConvSummary {
  id: string;
  other: { id: string; name: string; role: string };
  student: { id: string; name: string; classRoom?: { name: string } | null } | null;
  lastMessage: { body: string; createdAt: string; mine: boolean } | null;
  unread: number;
}

interface ThreadMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

interface ConvDetail {
  id: string;
  teacherUser: { id: string; name: string };
  guardianUser: { id: string; name: string };
  student: { id: string; name: string } | null;
  messages: ThreadMessage[];
}

export function ChatPanel() {
  const { me } = useMe();
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConvDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const role = me?.user?.role;

  const loadList = useCallback(async () => {
    try {
      const data = await api<ConvSummary[]>("/api/chat");
      setConvs(data);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try {
      const data = await api<ConvDetail>(`/api/chat?conversationId=${encodeURIComponent(id)}`);
      setDetail(data);
    } catch (e: any) {
      setError(e?.message || "Failed to load thread");
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 15000);
    return () => clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!activeId) return;
    loadThread(activeId);
    const t = setInterval(() => loadThread(activeId), 8000);
    return () => clearInterval(t);
  }, [activeId, loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      if (activeId && detail) {
        // Reply within the conversation — include context so backend can route.
        await api("/api/chat", {
          method: "POST",
          body: JSON.stringify({
            body: text,
            studentId: detail.student?.id,
            teacherUserId: role === "GUARDIAN" ? detail.teacherUser.id : undefined,
          }),
        });
      } else {
        await api("/api/chat", { method: "POST", body: JSON.stringify({ body: text }) });
      }
      setDraft("");
      await loadList();
      if (activeId) await loadThread(activeId);
    } catch (e: any) {
      setError(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading conversations…" />;

  const filtered = convs.filter(
    (c) => !q || c.other.name.toLowerCase().includes(q.toLowerCase()) || c.student?.name.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* conversation list */}
      <Card className={cn("h-fit overflow-hidden lg:col-span-1", activeId && "hidden lg:block")}>
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-800">Conversations</h3>
          <div className="relative mt-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input !py-1.5 !pl-8 text-xs" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {error && <div className="p-3"><ErrorNote message={error} /></div>}
        {filtered.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No conversations yet" description="Start a chat from a student page or send a message below." />
        ) : (
          <div className="max-h-[480px] overflow-y-auto">
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3 text-left transition hover:bg-slate-50",
                  activeId === c.id && "bg-indigo-50"
                )}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[11px] font-bold text-white">
                  {initials(c.other.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-bold text-slate-800">{c.other.name}</p>
                    {c.lastMessage && <span className="shrink-0 text-[10px] text-slate-400">{fmtDate(c.lastMessage.createdAt)}</span>}
                  </div>
                  <p className="truncate text-[11px] text-slate-500">
                    {c.student ? `${c.student.name} · ` : ""}
                    {c.lastMessage?.body || "No messages yet"}
                  </p>
                </div>
                {c.unread > 0 && (
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
                    {c.unread}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* thread */}
      <Card className="flex min-h-[480px] flex-col overflow-hidden lg:col-span-2">
        {activeId && detail ? (
          <>
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <button onClick={() => { setActiveId(null); setDetail(null); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 lg:hidden">
                <ArrowLeft size={18} />
              </button>
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {role === "GUARDIAN" ? detail.teacherUser.name : detail.guardianUser.name}
                </p>
                {detail.student && <p className="text-xs text-slate-400">about {detail.student.name}</p>}
              </div>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {detail.messages.map((m) => {
                const mine = m.senderId === me?.user.id;
                return (
                  <div key={m.id} className={cn("flex", mine ? "justify-end" : "")}>
                    <div className={cn("max-w-[80%] rounded-2xl px-4 py-2.5", mine ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800")}>
                      <p className="text-sm leading-relaxed">{m.body}</p>
                      <p className={cn("mt-1 text-[10px]", mine ? "text-indigo-200" : "text-slate-400")}>{fmtDate(m.createdAt, true)}</p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            <div className="border-t border-slate-100 p-4">
              <div className="flex gap-2">
                <input
                  className="input"
                  placeholder="Type a message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
                />
                <button onClick={send} disabled={sending || !draft.trim()} className="btn btn-primary">
                  {sending ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <MessageSquare size={24} />
            </div>
            <p className="text-sm font-bold text-slate-700">Select a conversation</p>
            <p className="max-w-xs text-xs text-slate-400">
              {role === "GUARDIAN"
                ? "Chat live with your child's teachers — replies arrive as notifications."
                : "Pick a conversation, or start one from a student's page."}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
