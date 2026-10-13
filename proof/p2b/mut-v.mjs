/** MUTATION v — make the replay answer also notify the desk (it must write nothing). */
import { readFileSync, writeFileSync } from "node:fs";

const f = "src/app/api/admissions/intake/route.ts";
const src = readFileSync(f, "utf8");
const needle = [
  "    return NextResponse.json({",
  "      data: {",
  "        admissionId: recordId,",
].join("\n");
const add = [
  "    await notifyUsers({",
  "      schoolId,",
  "      userIds: [session.id],",
  '      event: "ADMISSION_STATUS",',
  '      title: "Admission completed at the desk",',
  '      body: "mutation v: notify on a replay",',
  "      link: `/dashboard/students/${student.id}`,",
  "    });",
  needle,
].join("\n");
if (src.split(needle).length !== 2) {
  console.error(`needle not unique in ${f}`);
  process.exit(2);
}
writeFileSync(f, src.replace(needle, add));
console.log("mutation v applied (notify before the replay return)");
