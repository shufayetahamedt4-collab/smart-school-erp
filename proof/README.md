# proof/ — what is committed and what is not

Every stage of the college work writes its evidence here. The rule for the directory:

| committed | not committed |
|---|---|
| `REPORT.md` — the finished record of a stage | binary media: `*.png`, `*.webm`, `*.jpg`, `*.jpeg`, `*.gif`, `*.mp4` |
| the plain-text transcripts of the runs it cites (`*.txt`) | anything under a `.freebuff/` or scratch directory |
| small machine-readable result files (`*.json`) and the proof scripts (`*.mjs`) | `.env` variants, credentials, service-account files (never, anywhere) |

`.gitignore` carries the media patterns, so a new screenshot or screen recording is ignored by default
and has to be added deliberately. **The PNG/WEBM files committed before 2026-10-14 predate that rule and
stay tracked** — `git rm --cached` would remove them from the repository, which is a separate decision.

## Why the records are committed at all

A report that links to an evidence file which is not in git is a dead link for anyone who clones the
repository. So the Phase 7 records — `proof/7e/` and `proof/7f/` (reports plus their transcripts) and the
`proof/7d/mutate-*.txt` mutation transcripts — were committed on **2026-10-14**, which is what makes the
links in `PROGRESS.md`, `docs/COLLEGE-STATUS.md` and `proof/7f/REPORT.md` resolve.

## Reading these records

Each report describes the state of the tree **at the time that stage ran**, so sentences written while a
stage was under review ("uncommitted", "untracked until the change is committed") describe that moment,
not today. The Phase 7 stages ran on `e5ee07d` and were committed afterwards:

| what | commit |
|---|---|
| the college fee screens, print pages and the 7e/7f verifiers (code) | `f542405` |
| the docs sweep that closed 7d/7e/7f out | `efb97c0` |
| these evidence records (`proof/7e/`, `proof/7f/`, `proof/7d/mutate-*.txt`) | the `docs: commit Phase 7 evidence records` commit |

## Secret hygiene

Every file in this directory was scanned before the records were committed (emulator-only runs; QR
tokens, session cookies and the demo-kit logins that appear in transcripts are emulator fixtures, and
the demo login is documented in `README.md` / `src/lib/demo-accounts.ts`). No `.env`, credential or
service-account content is present, and none was opened while producing these records.
