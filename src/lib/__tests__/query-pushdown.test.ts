// @ts-nocheck — runs under `bun test`; the project's tsc has no bun-types installed.
import { describe, expect, test } from "bun:test";
import {
  classifyWhere,
  pushdownConditionsFor,
  pushableFields,
  supportedButUnpushed,
  isIdBatch,
  formatQueryDiag,
  HIGH_CARDINALITY_MODELS,
  PUSHDOWN_REASON,
  type QueryDiagEvent,
  type Pushdown,
} from "../query-diagnostics";

/**
 * A representative relation registry (mirrors the shape of RELS in db.ts). The
 * classifier is given this so it can leave relation keys to the in-memory filter.
 */
const RELATIONS: Record<string, string[]> = {
  student: ["school", "class", "section", "guardian", "family"],
  attendance: ["student", "school"],
  fee: ["student", "school"],
  examMark: ["student", "school", "exam"],
};
const isRel = (model: string) => (field: string) => (RELATIONS[model] || []).includes(field);

function cls(model: string, where: any) {
  return classifyWhere(where, isRel(model));
}
function pushedFields(model: string, where: any): string[] {
  return pushdownConditionsFor(where, isRel(model)).map((p) => p.field);
}
function pushedOps(model: string, where: any): Pushdown[] {
  return pushdownConditionsFor(where, isRel(model));
}

describe("pushdown: supported predicates reach Firestore", () => {
  test("schoolId + teacherId — both pushed (needs no composite index)", () => {
    const w = { schoolId: "s_1", teacherId: "t_1" };
    expect(pushedFields("attendance", w)).toEqual(["schoolId", "teacherId"]);
    expect(cls("attendance", w).cls).toBe("SAFE_PUSHED");
    expect(cls("attendance", w).unpushed).toEqual([]);
  });

  test("schoolId + active", () => {
    const w = { schoolId: "s_1", active: true };
    expect(pushedFields("student", w)).toEqual(["active", "schoolId"]);
    expect(cls("student", w).cls).toBe("SAFE_PUSHED");
  });

  test("schoolId + classId + sectionId", () => {
    const w = { schoolId: "s_1", classId: "c_1", sectionId: "sec_1" };
    expect(pushedFields("student", w)).toEqual(["classId", "schoolId", "sectionId"]);
    expect(cls("student", w).cls).toBe("SAFE_PUSHED");
  });

  test("studentId IN [...] — pushed as a single-field `in`", () => {
    const w = { studentId: { in: ["st_1", "st_2"] } };
    const ops = pushedOps("fee", w);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ field: "studentId", op: "in" });
    expect(cls("fee", w).cls).toBe("SAFE_PUSHED");
  });

  test("familyId and guardianUserId — single-field equalities", () => {
    expect(pushedFields("student", { familyId: "fam_1" })).toEqual(["familyId"]);
    expect(pushedFields("student", { guardianUserId: "u_1" })).toEqual(["guardianUserId"]);
    expect(cls("student", { guardianUserId: "u_1" }).cls).toBe("SAFE_PUSHED");
  });

  test("mixed: schoolId + status notIn — schoolId pushed, notIn stays in memory (PARTIAL_PUSH)", () => {
    const w = { schoolId: "s_1", status: { notIn: ["ALUMNI", "TRANSFERRED"] } };
    expect(pushedFields("student", w)).toEqual(["schoolId"]);
    const c = cls("student", w);
    expect(c.cls).toBe("PARTIAL_PUSH");
    expect(c.unpushed.map((u) => u.field)).toEqual(["status"]);
    expect(c.unpushed[0].reason).toBe(PUSHDOWN_REASON.OPERATOR);
  });
});

describe("pushdown: unsupported predicates keep the in-memory fallback", () => {
  test("document-id IN [...] — resolved by batched getAll, not by a where", () => {
    const w = { id: { in: ["st_1", "st_2"] } };
    expect(isIdBatch(w)).toBe(true);
    expect(cls("student", w).cls).toBe("BATCHED_BY_ID");
    expect(pushedFields("student", w)).toEqual([]);
  });

  test("date range — NOT pushed (Timestamp precision); schoolId still is", () => {
    const w = { schoolId: "s_1", date: { gte: new Date(0), lt: new Date(1) } };
    expect(pushedFields("attendance", w)).toEqual(["schoolId"]);
    const c = cls("attendance", w);
    expect(c.cls).toBe("PARTIAL_PUSH");
    expect(c.unpushed.find((u) => u.field === "date")?.reason).toBe(PUSHDOWN_REASON.OPERATOR);
  });

  test("relation filters are left to the in-memory resolver", () => {
    const w = { school: { name: "Sunrise" } };
    expect(pushedFields("student", w)).toEqual([]);
    const c = cls("student", w);
    expect(c.cls).toBe("FULL_COLLECTION_FALLBACK");
    expect(c.unpushed[0].reason).toBe(PUSHDOWN_REASON.RELATION);
  });

  test("OR / AND / NOT are not field equalities", () => {
    const w = { OR: [{ email: "a" }, { phone: "b" }] };
    expect(pushedFields("student", w)).toEqual([]);
    expect(cls("student", w).unpushed[0].reason).toBe(PUSHDOWN_REASON.LOGICAL);
  });

  test("contains / startsWith / gt are operator predicates", () => {
    expect(cls("student", { name: { contains: "an" } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.OPERATOR);
    expect(cls("student", { name: { startsWith: "A" } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.OPERATOR);
    expect(cls("student", { score: { gt: 5 } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.OPERATOR);
  });

  test("null is never pushed (a missing field matches null in memory only)", () => {
    const c = cls("student", { classId: null });
    expect(c.pushed).toEqual([]);
    expect(c.unpushed[0].reason).toBe(PUSHDOWN_REASON.NULL);
  });

  test("a Date VALUE is never pushed", () => {
    expect(cls("attendance", { date: new Date(0) }).unpushed[0].reason).toBe(PUSHDOWN_REASON.DATE);
  });

  test("`in` guards: empty, oversized and non-scalar lists are not pushed", () => {
    expect(cls("fee", { studentId: { in: [] } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.EMPTY_IN);
    const big = Array.from({ length: 31 }, (_, i) => `st_${i}`);
    expect(cls("fee", { studentId: { in: big } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.LARGE_IN);
    expect(cls("fee", { studentId: { in: ["st_1", null] } }).unpushed[0].reason).toBe(PUSHDOWN_REASON.NON_SCALAR_IN);
  });

  test("an unfiltered read is OTHER, not a flagged fallback", () => {
    expect(cls("student", {}).cls).toBe("OTHER");
    expect(cls("student", undefined).cls).toBe("OTHER");
  });
});

describe("regression guard: no supported predicate is ever left unpushed", () => {
  const cases: Array<[string, any]> = [
    ["attendance", { schoolId: "s", teacherId: "t" }],
    ["student", { schoolId: "s", active: true }],
    ["student", { schoolId: "s", classId: "c", sectionId: "sec" }],
    ["fee", { studentId: { in: ["a", "b"] } }],
    ["student", { familyId: "f" }],
    ["student", { guardianUserId: "u" }],
    ["student", { id: { in: ["x", "y"] } }],
    ["attendance", { schoolId: "s", date: { gte: new Date(0), lt: new Date(1) } }],
    ["student", { school: { name: "x" } }],
    ["student", { OR: [{ email: "a" }, { phone: "p" }] }],
    ["student", { name: { contains: "x" } }],
    ["student", { name: { startsWith: "A" } }],
    ["student", { score: { gt: 1 } }],
    ["student", { status: { notIn: ["ALUMNI"] } }],
    ["student", { classId: null }],
    ["attendance", { date: new Date(0) }],
    ["student", {}],
  ];

  for (const [model, where] of cases) {
    test(`${model} ${JSON.stringify(Object.keys(where))} — the pushed set is complete`, () => {
      // Every field the layer CAN push is present in the pushed set.
      expect(supportedButUnpushed(where, isRel(model))).toEqual([]);
      // And the pushed set is exactly the pushable set.
      const pushed = pushedFields(model, where).sort();
      const pushable = pushableFields(where, isRel(model)).sort();
      expect(pushed).toEqual(pushable);
    });
  }

  test("the guard is not vacuous — it detects a hand-removed pushdown", () => {
    // Simulate a regression: a where whose pushdown was dropped (empty pushed
    // set) while the field is still pushable.
    const where = { schoolId: "s_1" };
    const dropped: Pushdown[] = [];
    const pushedSet = new Set(dropped.map((p) => p.field));
    const undetected = pushableFields(where, isRel("student")).filter((f) => !pushedSet.has(f));
    expect(undetected).toEqual(["schoolId"]); // the guard WOULD flag this
  });
});

describe("diagnostic output is sanitized", () => {
  test("formatQueryDiag logs classifications, never predicate values", () => {
    const e: QueryDiagEvent = {
      kind: "fetch",
      model: "user",
      cls: "SAFE_PUSHED",
      pushed: ["email=="],
      unpushed: [],
      schoolScoped: false,
    };
    const line = formatQueryDiag(e);
    expect(line).toContain("[query-diag]");
    expect(line).toContain("user");
    expect(line).toContain("SAFE_PUSHED");
    // The diagnostic carries field names/ops only — never a value.
    expect(line).not.toContain("principal@sunrise.edu");
    expect(line).not.toContain("@");
  });

  test("high-cardinality set covers the collections that grow with a school", () => {
    for (const m of ["student", "attendance", "examMark", "fee", "payment", "message", "notice", "auditLog"]) {
      expect(HIGH_CARDINALITY_MODELS.has(m)).toBe(true);
    }
    expect(HIGH_CARDINALITY_MODELS.has("feeSetting")).toBe(false);
  });
});
