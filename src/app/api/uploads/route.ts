import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { adminApp, storageBucket } from "@/lib/firebase";
import { getSession } from "@/lib/auth";

const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "gif", "pdf", "doc", "docx", "xls", "xlsx", "txt", "zip"]);
const MAX_SIZE = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED.has(ext)) {
    return NextResponse.json({ error: `File type .${ext} is not allowed.` }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large (max 10MB)." }, { status: 400 });
  }

  const name = `${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
  const bucket = getStorage(adminApp()).bucket(storageBucket());
  const blob = bucket.file(`uploads/${name}`);

  await blob.save(Buffer.from(await file.arrayBuffer()), {
    contentType: file.type || "application/octet-stream",
    public: true,
    metadata: { contentType: file.type || "application/octet-stream" },
  });

  const url = `https://storage.googleapis.com/${storageBucket()}/uploads/${name}`;
  return NextResponse.json({ data: { url } });
}
