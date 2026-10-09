import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { adminApp, storageBucket } from "@/lib/firebase";
import { getSession } from "@/lib/auth";

const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "gif", "pdf", "doc", "docx", "xls", "xlsx", "txt", "zip"]);
const MAX_SIZE = 10 * 1024 * 1024;

// Certificate artwork (logo / watermark / seal / signatures) is stricter:
// images only, 2 MB, always inside the school's own folder so the template
// validator's certificates/{schoolId}/ prefix check passes.
const CERT_ALLOWED = new Set(["jpg", "jpeg", "png", "webp"]);
const CERT_MAX_SIZE = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  // Certificate mode: ?kind=certificate (admin-only, school-scoped path).
  const isCert = req.nextUrl.searchParams.get("kind") === "certificate";
  if (isCert && session.role !== "SCHOOL_ADMIN" && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const allowed = isCert ? CERT_ALLOWED : ALLOWED;
  if (!allowed.has(ext)) {
    return NextResponse.json(
      { error: isCert ? `Certificate artwork must be an image (jpg, png, webp).` : `File type .${ext} is not allowed.` },
      { status: 400 }
    );
  }
  const maxSize = isCert ? CERT_MAX_SIZE : MAX_SIZE;
  if (file.size > maxSize) {
    return NextResponse.json(
      { error: isCert ? "Image too large (max 2MB for certificate artwork)." : "File too large (max 10MB)." },
      { status: 400 }
    );
  }

  // Folder: uploads/ for general files; certificates/{schoolId}/ for
  // certificate artwork so URLs are school-scoped by construction.
  let folder = "uploads";
  if (isCert) {
    const schoolId = session.role === "SUPER_ADMIN" ? form.get("schoolId") : session.schoolId;
    if (!schoolId || typeof schoolId !== "string") {
      return NextResponse.json({ error: "No school context — cannot scope the upload." }, { status: 400 });
    }
    folder = `certificates/${schoolId}`;
  }

  const name = `${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
  const bucket = getStorage(adminApp()).bucket(storageBucket());
  const blob = bucket.file(`${folder}/${name}`);

  await blob.save(Buffer.from(await file.arrayBuffer()), {
    contentType: file.type || "application/octet-stream",
    public: true,
    metadata: { contentType: file.type || "application/octet-stream" },
  });

  const url = `https://storage.googleapis.com/${storageBucket()}/${folder}/${name}`;
  return NextResponse.json({ data: { url } });
}
