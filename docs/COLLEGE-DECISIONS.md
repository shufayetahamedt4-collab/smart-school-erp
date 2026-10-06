# College Support — Approved Product Decisions

Plain-language record of the decisions that shape College support on the one platform.
These are the source of truth for every later phase. Companion documents:

- `docs/COLLEGE-PLAN.md` — the original A–I architecture plan. **Not saved to this repository**;
  it was delivered as chat prose and never written to disk. It is intentionally absent.
- `docs/COLLEGE-PLAN-DELTA.md` — the delta plan for `institutionType = SCHOOL | COLLEGE | BOTH`.
  It supersedes only the parts of the original plan that this one decision changed; sections A–I
  remain valid everywhere the delta does not contradict them.

---

## 1. One platform, one tenant, an institution type

Every tenant is the **same** product on the **same** backend and database. There is no separate
"college product" and no second tenant model. What changes is a single field on the tenant:

```
schools.institutionType = "SCHOOL" | "COLLEGE" | "BOTH"
```

- **Absent means `SCHOOL`.** A tenant document with no `institutionType` behaves exactly like a
  tenant whose type is `"SCHOOL"`. There is **no backfill and no migration** — every school that
  exists today, and every school document written by any other code path, simply reads as `SCHOOL`.
- The field is only ever written by explicit Super Admin action (creating or editing a tenant).
- Allowed values are exactly three: `SCHOOL`, `COLLEGE`, `BOTH`. Anything else is rejected.

## 2. What each type means

| Type | What the tenant runs | Switcher |
|---|---|---|
| `SCHOOL` | School only. Today's UI, unchanged. | None |
| `COLLEGE` | College only. | None |
| `BOTH` | School **and** college, together, in the same tenant. | A School \| College switcher (Phase M) |

For a `SCHOOL` tenant, **nothing changes**. Existing school tenants must behave and look identical
to before College support. No school-facing, admin-facing, teacher-facing or guardian-facing screen
changes in the foundation phase — the only new UI is the Super Admin tenant control that sets the
type.

## 3. Mode

```
Mode = "SCHOOL" | "COLLEGE"
```

- **Mode is UI context, not security.** It selects which half of a `BOTH` tenant the interface is
  showing. It is never an authorization decision.
- The server must **never** trust a cookie or a `?mode=` query parameter as authorization. Tenant
  isolation, `can()` and the permission matrix remain the only enforcement. A request that asks for
  a mode the tenant's `institutionType` does not allow is refused or filtered — it is never treated
  as a grant of access.
- A `SCHOOL` tenant only ever has the `SCHOOL` mode available; a `COLLEGE` tenant only `COLLEGE`;
  a `BOTH` tenant has both.
- Activation details (an `ss_mode` cookie, a `POST /api/mode` route, `?mode=` on mode-scoped reads)
  are designed in the delta plan and are implemented in **Phase M**, not now.

## 4. Core rows carry a mode later

Core rows — `classes`, `subjects`, `students` — will get a stored `mode` field in a later phase so a
`BOTH` tenant can keep the two halves apart. **Missing `mode` means `SCHOOL`**, exactly like the
tenant field: no backfill, existing school rows keep working untouched, and a `SCHOOL` tenant never
notices the field exists. This is **not** part of the foundation phase.

## 5. People in a `BOTH` tenant

- **Teacher:** gets the switcher only if the teacher actually works in both modes. A teacher who
  works in one mode sees that mode and no switcher. (Later phase.)
- **Guardian:** gets **no** global switcher. The guardian's portal follows the **selected child**:
  the child's mode decides the context. (Later phase.)
- **Super Admin:** chooses the tenant's type. The learner/staff experience inside a `BOTH` tenant is
  defined by the phases that follow.

## 6. Changing a tenant's type — the rule

Type changes are **Super Admin only**, are validated against the three allowed values, and always
write an audit entry. The approved transitions are:

| From → To | Allowed? |
|---|---|
| `SCHOOL` → `BOTH` | **Always allowed.** Adding college to a school never destroys anything. |
| `COLLEGE` → `BOTH` | **Always allowed.** Adding school to a college never destroys anything. |
| `BOTH` → `SCHOOL` | **Only when the tenant has no college data.** |
| `COLLEGE` → `SCHOOL` | **Only when the tenant has no college data.** |

Any other transition (`SCHOOL` → `COLLEGE`, `BOTH` → `COLLEGE`) is **not yet defined** and is
refused with an explicit reason until a later phase gives it a rule. Changing a type to itself is a
no-op.

The point of the restriction is honesty: a tenant that already holds college rows must not be
silently turned into a school-only tenant, or those rows would become unreachable. Until the college
collections exist, "has college data" is a function that truthfully reports **no college data**, and
the downgrade is therefore permitted in practice today. That function is the single place later
phases must extend — see `src/lib/institution.ts` (`schoolHasCollegeData` and
`canChangeInstitutionType`). Setting the type at tenant **creation** accepts all three values; the
table above governs only **changes**.

## 7. Phase M inherits these

Phase M (the mode switcher) introduces the school | college toggle for `BOTH` tenants. It **inherits
every decision above** and must not restate them differently: mode stays UI context and never
authorization; `SCHOOL`/`COLLEGE` tenants stay switcher-free; the type change rule is unchanged; and
core rows keep the `missing = SCHOOL` convention. Where the delta plan and this document disagree,
this document wins, and the delta plan is corrected.
