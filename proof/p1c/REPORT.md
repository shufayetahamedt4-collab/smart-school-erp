# pilot P1c — browser proof (one Chrome over CDP, `proof/p1c/`)

Emulator only (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, project `demo-ss-test`).
Driver: `scripts/lib/headless.mjs` (`launch()` → one browser, one page, 1280×900).
An admin admits a student with a new guardian **through the admission form**; the
guardian then fails password sign-in twice, succeeds with the QR slip, sees only
their own child; the admin re-issues the slip. Fixtures removed afterwards
(student DELETE cascades owned rows; admission + guardian user deleted directly).

17/17 browser checks (`BROWSER PROOF COMPLETE`, exit 0).

| PNG | DOM text that matters |
|---|---|
| `01-admission-form-has-no-password-field.png` | `Initial password` absent · `The guardian signs in with the QR slip for this student — no password is needed. The slip prints on the success screen and can be re-issued from the student page.` · class selected (`ok-select:<classId>`) |
| `02-guardian-cannot-sign-in-with-old-default.png` | Parents App login with the new guardian email + `Guardian@123` → `Invalid credentials` · `/api/auth/me` → 401 (no session minted) |
| `03-guardian-cannot-sign-in-with-a-guess.png` | same email + `Sunrise123` → `Invalid credentials` (same shape) |
| `04-guardian-signs-in-with-qr-slip-sees-only-own-child.png` | `/qr/<token>` → `Guardian verification` → PIN → `/parent` shows `P1C Proof Child <stamp>` and NOT the demo family's child (`Ayan Rahman` absent) |
| `05-admin-reissues-the-slip.png` | student page `Guardian PIN` shows the re-issued `4402` after Reset + Save |

The admitted student carried the same slip on the success screen and on the
admin's API read (`qrToken` 32-hex + 4-digit `qrPin`); the old PIN stops working
after the re-issue (proved at the API level in `verify-pilot-hardening`
`p1c-live`: OLD pin 401, NEW pin 200).
