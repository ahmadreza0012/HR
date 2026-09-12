# Ontario demo payroll and report integrity

`/admin/seed-demo` is deliberately the only operation that creates sample payroll data. It creates six fictional Ontario employees and daily April–September 2026 records. Every created record and report carries `DEMO / SIMULATED DATA — NOT FOR IRCC`; it must never be presented as historical employment evidence.

The schedule is Monday–Friday 08:00–17:00 with a 60-minute unpaid break, Saturday 08:00–14:00 with a 60-minute unpaid break, and Sunday off. Ontario public holidays and zero-hour days are persisted as records. The seed calculator records CPP, CPP2, EI, federal tax, Ontario tax, Ontario Health Premium, vacation pay, gross and net in the result snapshot. It is an illustrative test calculator, not a remittance or tax filing engine.

## Deploy the Sheets gateway

1. Open `google-apps-script/Code.gs` in the Apps Script project attached to the supplied Google Sheet and replace its contents.
2. Deploy a new Web app version (execute as the owner; access: anyone with the link) and copy its `/exec` URL.
3. In Vercel set `GOOGLE_SCRIPT_URL` to that URL as a Secret and set `VITE_API_URL=/api` as Config. Redeploy.
4. Call `POST /api/admin/seed-demo` once. Repeating it is safe: existing demo identifiers are not duplicated.

The Google Sheet is set to `America/Toronto` and contains an append-only `report_registry` tab. Its audit tab receives seed, write, delete/void and report-issued events.

## Reports and verification

Reports are created per employee and per requested range. The Apps Script snapshot includes all overlapping pay periods. Reports produce one file at a time through `/api/reports/generate`; each binary's SHA-256 and the frozen source payload hash are recorded before download. Enter the report ID and SHA-256 in `/verify` to receive `Valid`, `Altered`, `Unknown`, or `Missing`.

The PDF itself is not a certificate-backed digital signature. Its integrity guarantee is the registered SHA-256 snapshot trail. Cover sheets for source data only state that the export job did not create, change, estimate, backdate, or approve records. For demo rows the cover sheet instead explicitly disclaims IRCC use.
