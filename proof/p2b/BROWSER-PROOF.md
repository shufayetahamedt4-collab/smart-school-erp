# pilot P2b — browser proof (one Chrome over CDP, `proof/p2b/`)

Emulator only (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, project `demo-ss-test`), app on `http://127.0.0.1:3000`, driver `scripts/lib/headless.mjs` (one browser, one page, 1280×1000).

17/17 browser checks (`BROWSER PROOF COMPLETE`, exit 0).

| PNG | DOM text captured with it |
|---|---|
| `01-form-filled.png` | `New Admission · Everything the desk knows, captured once — student, guardian, fees, kit and QR credentials · Students · Student information · Full name * · Full name (Bangla) · Admission number · Registration no. · Date of birth · Birth certificate no. · Gender · MALE · FEMALE · OTHER · Blood group · A_POS · A_NEG · B_POS · B_NEG · AB_POS · AB_NEG · O_POS · O_NEG · Religion · ISLAM · HINDU · CHRIS` |
| `02-in-flight-disabled.png` | button `"Admitting…"`, `disabled=true` while the request was in flight · `New Admission · Everything the desk knows, captured once — student, guardian, fees, kit and QR credentials · Students · Student information · Full name * · Full name (Bangla) · Admission number · Registration no. · Date of birth · Birth certificate no. · Gender · MALE · FEMALE · OTHER · Blood group · A_POS · A_NEG · B_POS · B_NEG · AB_POS · AB_NEG · O_POS · O_NEG · Religion · ISLAM · HINDU · CHRIS` |
| `03-admitted-once.png` | `Sign out · Sunrise International School · SCHOOL ADMIN · 1 · NJ · Nusrat Jahan (Principal) · principal@sunrise.edu · Student admitted · P2b Browser P2BUImv6bhqep · ADM-970155 · Class 1 · DONE AUTOMATICALLY · admission record created · student record created · guardian login created · admission fee raised · monthly fee raised (1500) · payment of 500 confirmed (RCP-7397043081) · admission marked enr` |

Double-clicking Submit sent **1** POST to `/api/admissions/intake` and created **1** student (one admission, one fee set, one receipt), with the button `disabled=true` / `"Admitting…"` while the request was in flight.
