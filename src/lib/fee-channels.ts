/**
 * Payment channels — where a school actually takes its money.
 *
 * A Bangladeshi school collects through a bKash merchant number, a Nagad
 * personal number, a bank account, and often simply "at the office". The school
 * (not the platform) owns these details, so the admin maintains them and the
 * Parents App shows them next to the fee that is due.
 *
 * One channel can serve several payment methods — a single bKash merchant
 * account covers the BKASH intent — so `methods` is a list, not a single value.
 * A channel with no method attached is still worth showing ("Pay at the school
 * office, 9am–2pm"): it is payable but not online.
 *
 * Kept dependency-free so both server routes and client pages can import it.
 */

export type ChannelKind = "MOBILE" | "BANK" | "CASH";

export const CHANNEL_KINDS: ChannelKind[] = ["MOBILE", "BANK", "CASH"];

/** The payment methods the ledger/checkout knows about. */
export const PAY_METHODS = ["BKASH", "NAGAD", "ROCKET", "CARD", "BANK", "CASH"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export interface PaymentChannel {
  /** Stable id so a page can edit a row without relying on its index. */
  id: string;
  enabled: boolean;
  kind: ChannelKind;
  /** What the school calls it — "bKash", "Dutch-Bangla Bank", "Pay at the office". */
  label: string;
  /** Which payment methods this channel serves (empty = walk-in only). */
  methods: string[];
  /** Mobile wallet number, or the bank account number. */
  number: string | null;
  /** "Merchant" / "Personal" / "Current" … */
  accountType: string | null;
  accountName: string | null;
  bankName: string | null;
  branch: string | null;
  routingNumber: string | null;
  instructions: string | null;
}

const str = (v: unknown, max = 120): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Fresh id for a newly added channel (client-side, before it is saved). */
export function newChannelId(): string {
  return `ch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Normalise whatever the admin's browser sent into storable channels.
 *
 * A channel without a label is dropped (nothing to show a parent), and an
 * unknown kind falls back to MOBILE rather than being rejected — the label and
 * the numbers are what matter to the family reading it.
 */
export function cleanChannels(raw: unknown): PaymentChannel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any, i: number) => {
      const label = str(c?.label, 60) || "";
      const methods = Array.isArray(c?.methods)
        ? c.methods.map((m: unknown) => String(m).toUpperCase()).filter((m: string) => (PAY_METHODS as readonly string[]).includes(m))
        : [];
      return {
        id: str(c?.id, 40) || `ch_${i}_${Math.random().toString(36).slice(2, 7)}`,
        enabled: c?.enabled !== false,
        kind: (CHANNEL_KINDS as string[]).includes(c?.kind) ? (c.kind as ChannelKind) : "MOBILE",
        label,
        // De-duplicate while keeping the order the admin chose.
        methods: [...new Set(methods)],
        number: str(c?.number, 40),
        accountType: str(c?.accountType, 40),
        accountName: str(c?.accountName, 80),
        bankName: str(c?.bankName, 80),
        branch: str(c?.branch, 80),
        routingNumber: str(c?.routingNumber, 40),
        instructions: str(c?.instructions, 300),
      } as PaymentChannel;
    })
    .filter((c) => c.label);
}

/** The enabled channels a guardian can actually use, in the school's order. */
export function usableChannels(channels: PaymentChannel[] | undefined | null): PaymentChannel[] {
  return (channels || []).filter((c) => c && c.enabled !== false);
}

/** The channel that answers for a payment method, or null when none is set. */
export function channelForMethod(
  channels: PaymentChannel[] | undefined | null,
  method: string
): PaymentChannel | null {
  const want = String(method || "").toUpperCase();
  return usableChannels(channels).find((c) => c.methods.includes(want)) || null;
}

/** One line describing where to send the money — used in the parents' app. */
export function channelDestination(c: PaymentChannel): string {
  if (c.kind === "BANK") {
    return [c.bankName, c.accountName, c.number ? `A/C ${c.number}` : null, c.branch, c.routingNumber ? `Routing ${c.routingNumber}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return [c.number, c.accountType, c.accountName].filter(Boolean).join(" · ");
}
