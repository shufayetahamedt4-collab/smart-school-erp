"use client";

import { useEffect, useState } from "react";
import { Send, MessageSquare, Users, GraduationCap } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Textarea, Select, EmptyState, LoadingScreen, ErrorNote, Spinner } from "@/components/ui";
import { fmtDate, initials } from "@/lib/utils";
import { useMe } from "./Shell";

interface Msg {
  id: string; body: string; createdAt: string; readAt: string | null;
  sender: { id: string; name: string; role: string };
  receiver: { id: string; name: string; role: string } | null;
  student: { id: string; name: string } | null;
}

interface Contact {
  id: string; name: string; role: string;
}

export function MessagesPanel() {
  const { me } = useMe();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [receiverId, setReceiverId] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const role = me?.user?.role;

  const load = async () => {
    const msgs = await api<Msg[]>("/api/messages");
    setMessages(msgs);
  };

  useEffect(() => {
    if (!me) return;
    setLoading(true);
    Promise.all([
      load(),
      (async () => {
        if (role === "GUARDIAN") {
          const ts = await api<any[]>("/api/teachers");
          setContacts(ts.filter((t) => t.user).map((t) => ({ id: t.user.id, name: t.user.name, role: "TEACHER" })));
        } else {
          const gs = await api<Contact[]>("/api/guardians").catch(() => []);
          const ts = await api<any[]>("/api/teachers").catch(() => []);
          setContacts([
            ...gs.map((g) => ({ id: g.id, name: g.name, role: "GUARDIAN" })),
            ...ts.filter((t) => t.user).map((t) => ({ id: t.user.id, name: t.user.name, role: "TEACHER" })),
          ]);
        }
      })(),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [me, role]);

  const send = async () => {
    if (!receiverId || !body.trim()) return;
    setSending(true);
    setError("");
    try {
      await api("/api/messages", { method: "POST", body: JSON.stringify({ receiverId, body }) });
      setBody("");
      setReceiverId("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading messages…" />;

  const otherName = (m: Msg) => (m.sender.id === me?.user.id ? m.receiver?.name || "Unknown" : m.sender.name);
  const isIncoming = (m: Msg) => m.sender.id !== me?.user.id;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* compose */}
      <Card className="h-fit lg:col-span-1">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-800">New message</h3>
          <p className="text-xs text-slate-400">
            {role === "GUARDIAN" ? "Send a message to your child's teachers" : "Message guardians or teachers"}
          </p>
        </div>
        <div className="space-y-3 p-5">
          {error && <ErrorNote message={error} />}
          <div>
            <label className="label">To</label>
            <Select value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
              <option value="">Select recipient…</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.role === "GUARDIAN" ? "Guardian" : "Teacher"})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="label">Message</label>
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type your message…" />
          </div>
          <button className="btn btn-primary w-full" onClick={send} disabled={sending || !receiverId || !body.trim()}>
            {sending ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <Send size={15} />}
            Send message
          </button>
        </div>
      </Card>

      {/* inbox */}
      <Card className="lg:col-span-2">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-800">Inbox</h3>
          <p className="text-xs text-slate-400">{messages.length} messages</p>
        </div>
        {messages.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No messages yet" description="Start a conversation with a guardian or teacher." />
        ) : (
          <div className="max-h-[520px] space-y-3 overflow-y-auto p-5">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${isIncoming(m) ? "" : "justify-end"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${isIncoming(m) ? "bg-slate-100" : "bg-indigo-600 text-white"}`}>
                  <div className={`mb-1 flex items-center gap-2 text-[11px] font-bold ${isIncoming(m) ? "text-slate-500" : "text-indigo-200"}`}>
                    {isIncoming(m) && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[9px] text-indigo-600">{initials(m.sender.name)}</span>}
                    {otherName(m)}
                    {m.student && <span className="opacity-70">· {m.student.name}</span>}
                    <span className={`ml-1 font-normal opacity-60`}>{fmtDate(m.createdAt, true)}</span>
                  </div>
                  <p className="text-sm leading-relaxed">{m.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
