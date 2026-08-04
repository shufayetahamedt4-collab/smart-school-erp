import { randomBytes } from "node:crypto";

export function qrToken(): string {
  return randomBytes(16).toString("hex");
}

export function qrPin(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

export function qrUrl(token: string): string {
  const base = process.env.APP_URL || "http://localhost:3000";
  return `${base}/qr/${token}`;
}
