"use client";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error || "Request failed", res.status);
  }
  return body?.data as T;
}

export async function upload(url: string, form: FormData): Promise<any> {
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error || "Upload failed", res.status);
  return body?.data;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!clean.length) return "";
  return "?" + clean.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
