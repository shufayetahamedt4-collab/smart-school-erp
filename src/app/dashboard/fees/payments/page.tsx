"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Save, Smartphone, Landmark, HandCoins, Wallet } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Textarea, Select, Modal, PageHeader, LoadingScreen, ErrorNote, EmptyState } from "@/components/ui";
import {
  CHANNEL_KINDS, PAY_METHODS, cleanChannels, channelDestination, newChannelId,
  type PaymentChannel, type ChannelKind,
} from "@/lib/fee-channels";

/**
 * PRD §10.2 — the school's payment channels.
 *
 * Whatever the school actually collects through: a bKash merchant number, a
 * Nagad number, a bank account, or the office counter. The admin maintains
 * them here and the Parents App shows them next to the fee that is due, so a
 * family knows where to send the money without ringing the office.
 */

const KIND_ICON: Record<ChannelKind, typeof Wallet> = {
  MOBILE: Smartphone,
  BANK: Landmark,
  CASH: HandCoins,
};

const KIND_LABEL: Record<ChannelKind, string> = {
  MOBILE: "Mobile wallet",
  BANK: "Bank account",
  CASH: "Walk-in / cash",
};

const BLANK: PaymentChannel = {
  id: "",
  enabled: true,
  kind: "MOBILE",
  label: "",
  methods: [],
  number: null,
  accountType: null,
  accountName: null,
  bankName: null,
  branch: null,
  routingNumber: null,
  instructions: null,
};

export default function PaymentChannelsPage() {
  const [channels, setChannels] = useState<PaymentChannel[]>([]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentChannel>(BLANK);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => {
    api<any>("/api/fees/settings")
      .then((d) => {
        setChannels(cleanChannels(d?.channels));
        setNote(d?.paymentNote || "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async (next = channels, nextNote = note) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/fees/settings", { method: "POST", body: JSON.stringify({ channels: next, paymentNote: nextNote }) });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openAdd = () => {
    setEditId(null);
    setDraft({ ...BLANK, id: newChannelId() });
    setError("");
    setEditOpen(true);
  };

  const openEdit = (c: PaymentChannel) => {
    setEditId(c.id);
    setDraft({ ...BLANK, ...c, methods: [...(c.methods || [])] });
    setError("");
    setEditOpen(true);
  };

  const commitDraft = async () => {
    if (!draft.label.trim()) {
      setError("Give the channel a name — that is what families see.");
      return;
    }
    const next = editId
      ? channels.map((c) => (c.id === editId ? { ...draft, id: editId } : c))
      : [...channels, { ...draft, id: draft.id || newChannelId() }];
    setChannels(next);
    setEditOpen(false);
    await save(next);
  };

  const toggleEnabled = async (c: PaymentChannel) => {
    const next = channels.map((x) => (x.id === c.id ? { ...x, enabled: c.enabled === false } : x));
    setChannels(next);
    await save(next);
  };

  const remove = async (c: PaymentChannel) => {
    if (!window.confirm(`Remove "${c.label}" from your payment channels?`)) return;
    const next = channels.filter((x) => x.id !== c.id);
    setChannels(next);
    await save(next);
  };

  const setMethod = (value: string) =>
    setDraft((d) => ({
      ...d,
      methods: d.methods.includes(value) ? d.methods.filter((m) => m !== value) : [...d.methods, value],
    }));

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Payment channels"
        subtitle="Where your school collects fees. Guardians see these in the Parents App, beside the fee that is due."
        actions={
          <>
            <button className="btn btn-primary btn-sm" onClick={openAdd}><Plus size={14} /> Add channel</button>
            <button className="btn btn-secondary btn-sm" onClick={() => save()} disabled={busy}>
              <Save size={14} /> {busy ? "Saving…" : "Save"}
            </button>
          </>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
      {saved && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          Payment channels saved — guardians will see them on their Fees page.
        </div>
      )}

      <Card className="mb-4">
        <CardHeader title="Channels" subtitle="bKash, Nagad, Rocket, a bank account, or the office counter — add as many as you use." />
        {channels.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Channel</th>
                  <th className="th">Where to send</th>
                  <th className="th">Used for</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const Icon = KIND_ICON[c.kind] || Wallet;
                  return (
                    <tr key={c.id} className="tr-hover align-top">
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                            <Icon size={15} />
                          </span>
                          <div>
                            <div className="font-bold text-slate-800">{c.label}</div>
                            <div className="text-[11px] text-slate-400">{KIND_LABEL[c.kind]}</div>
                          </div>
                        </div>
                      </td>
                      <td className="td text-xs text-slate-600">{channelDestination(c) || "—"}</td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1">
                          {c.methods.length ? c.methods.map((m) => (
                            <Badge key={m} tone="blue">{m.replace(/_/g, " ")}</Badge>
                          )) : <span className="text-[11px] text-slate-400">Walk-in only</span>}
                        </div>
                      </td>
                      <td className="td">
                        <Badge tone={c.enabled === false ? "slate" : "green"}>{c.enabled === false ? "Hidden" : "Shown"}</Badge>
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1.5">
                          <button className="btn btn-secondary btn-sm" onClick={() => toggleEnabled(c)}>
                            {c.enabled === false ? "Show" : "Hide"}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)} title="Edit"><Pencil size={13} /></button>
                          <button className="btn btn-secondary btn-sm" onClick={() => remove(c)} title="Remove"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title="No payment channels yet"
            description="Add your bKash number so families can pay without coming to the office."
            action={<button className="btn btn-primary btn-sm" onClick={openAdd}><Plus size={14} /> Add channel</button>}
          />
        )}
      </Card>

      <Card className="p-5">
        <Field label="Note for guardians" hint="Shown above the payment channels in the Parents App — e.g. send the money, then submit the transaction ID here.">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => save(channels, note)}
            placeholder="Please send the fee to one of these numbers, then bring the transaction ID to the office."
          />
        </Field>
      </Card>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={editId ? "Edit channel" : "Add payment channel"} wide>
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What families see — “bKash”, “Nagad”, “Dutch-Bangla Bank”, “School counter”.">
              <TextInput value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <Field label="Kind">
              <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ChannelKind })}>
                {CHANNEL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Used for" hint="Which payment methods this channel answers. Leave empty for a walk-in counter.">
            <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 p-3">
              {PAY_METHODS.map((m) => (
                <label key={m} className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    checked={draft.methods.includes(m)}
                    onChange={() => setMethod(m)}
                  />
                  {m}
                </label>
              ))}
            </div>
          </Field>

          {draft.kind === "BANK" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bank name"><TextInput value={draft.bankName || ""} onChange={(e) => setDraft({ ...draft, bankName: e.target.value })} /></Field>
              <Field label="Account name"><TextInput value={draft.accountName || ""} onChange={(e) => setDraft({ ...draft, accountName: e.target.value })} /></Field>
              <Field label="Account number"><TextInput value={draft.number || ""} onChange={(e) => setDraft({ ...draft, number: e.target.value })} /></Field>
              <Field label="Branch"><TextInput value={draft.branch || ""} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} /></Field>
              <Field label="Routing number"><TextInput value={draft.routingNumber || ""} onChange={(e) => setDraft({ ...draft, routingNumber: e.target.value })} /></Field>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={draft.kind === "CASH" ? "Counter / room" : "Number"}>
                <TextInput value={draft.number || ""} onChange={(e) => setDraft({ ...draft, number: e.target.value })} />
              </Field>
              <Field label="Account type" hint="Merchant, Personal, Current…">
                <TextInput value={draft.accountType || ""} onChange={(e) => setDraft({ ...draft, accountType: e.target.value })} />
              </Field>
              <Field label="Account name"><TextInput value={draft.accountName || ""} onChange={(e) => setDraft({ ...draft, accountName: e.target.value })} /></Field>
            </div>
          )}

          <Field label="Instructions (optional)" hint="Anything a parent must know — reference format, timing, who to tell.">
            <Textarea value={draft.instructions || ""} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} />
          </Field>

          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              checked={draft.enabled !== false}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Show this channel to guardians
          </label>

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setEditOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={commitDraft} disabled={busy}>
              {busy ? "Saving…" : editId ? "Save channel" : "Add channel"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
