# VetteIntel C7 Sticker Harvester — Cloudflare

Cloudflare-native acquisition service for publicly linked C7 Corvette window stickers.

## Architecture

- **Worker:** discovery, downloading, API, and scheduled batch processing
- **D1:** profile queue, crawl runs, sticker metadata, retries, deduplication
- **R2:** unchanged profile HTML and original sticker image/PDF assets
- **Cron Trigger:** processes a small batch every 15 minutes
- **Admin token:** protects every operational endpoint

Acquisition and parsing are intentionally separate. This version finds and preserves
the original sticker assets. OCR and C7 field parsing should be added only after the
first downloaded batch is visually reviewed.

## 1. Prerequisites

Install Node.js 20 or newer, then open a terminal in this folder:

```bash
npm install
npx wrangler login
```

## 2. Create Cloudflare resources

```bash
npm run db:create
npm run r2:create
```

The D1 command prints a database ID. Paste it into `wrangler.jsonc`, replacing:

```text
REPLACE_WITH_D1_DATABASE_ID
```

The R2 bucket name already matches the configuration.

## 3. Create the database tables

```bash
npm run db:migrate:remote
```

## 4. Add the admin secret

Choose a long random value:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Wrangler will prompt you to enter it. Keep it private.

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints a URL similar to:

```text
https://vetteintel-c7-sticker-harvester.<subdomain>.workers.dev
```

Set these shell variables for the examples below:

### Windows PowerShell

```powershell
$BASE="https://vetteintel-c7-sticker-harvester.<subdomain>.workers.dev"
$TOKEN="YOUR_ADMIN_TOKEN"
```

### macOS/Linux

```bash
export BASE="https://vetteintel-c7-sticker-harvester.<subdomain>.workers.dev"
export TOKEN="YOUR_ADMIN_TOKEN"
```

## 6. Confirm the deployment

PowerShell:

```powershell
Invoke-RestMethod "$BASE/health"
```

macOS/Linux:

```bash
curl "$BASE/health"
```

## 7. Load the five verified seed profiles

PowerShell:

```powershell
$body = Get-Content .\seeds\verified-profiles.json -Raw
Invoke-RestMethod `
  -Method Post `
  -Uri "$BASE/api/admin/seed" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body $body
```

macOS/Linux:

```bash
curl -X POST "$BASE/api/admin/seed" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @seeds/verified-profiles.json
```

## 8. Run the first batch immediately

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "$BASE/api/admin/run" `
  -Headers @{ Authorization = "Bearer $TOKEN" }
```

macOS/Linux:

```bash
curl -X POST "$BASE/api/admin/run" \
  -H "Authorization: Bearer $TOKEN"
```

The Cron Trigger will also run automatically every 15 minutes.

## 9. Check progress

PowerShell:

```powershell
Invoke-RestMethod `
  -Uri "$BASE/api/status" `
  -Headers @{ Authorization = "Bearer $TOKEN" }
```

macOS/Linux:

```bash
curl "$BASE/api/status" \
  -H "Authorization: Bearer $TOKEN"
```

## 10. List downloaded sticker records

PowerShell:

```powershell
Invoke-RestMethod `
  -Uri "$BASE/api/assets?limit=50" `
  -Headers @{ Authorization = "Bearer $TOKEN" }
```

macOS/Linux:

```bash
curl "$BASE/api/assets?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

Each record includes an `asset_id`. View the corresponding private R2 object through:

```text
GET /api/asset/:asset_id
```

Example:

```bash
curl "$BASE/api/asset/ASSET_ID" \
  -H "Authorization: Bearer $TOKEN" \
  --output sticker.jpg
```

## 11. Discover more registry profiles

After the five seeds work:

```bash
curl -X POST "$BASE/api/admin/discover" \
  -H "Authorization: Bearer $TOKEN"
```

Then run another batch or allow Cron to process the queue.

## Safe rollout order

1. Deploy.
2. Seed five verified profiles.
3. Run one batch.
4. Inspect D1 status and R2 assets.
5. Confirm sticker images are genuine and readable.
6. Run discovery.
7. Leave the Cron Trigger enabled.
8. Add OCR only after acquisition quality is known.

## Configuration

In `wrangler.jsonc`:

- `BATCH_SIZE`: profiles per run; start at `5`
- `SOURCE_DELAY_MS`: delay between profile requests; start at `1500`
- `MAX_ASSET_BYTES`: raw sticker maximum; default 15 MB
- `SOURCE_ENABLED`: emergency kill switch
- Cron: currently every 15 minutes

## Operational endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Public health check |
| GET | `/api/status` | Queue and last-run summary |
| POST | `/api/admin/seed` | Insert known profile URLs |
| POST | `/api/admin/discover` | Discover profiles from registry index |
| POST | `/api/admin/run` | Process one batch |
| GET | `/api/assets` | List sticker records |
| GET | `/api/asset/:assetId` | Privately stream an R2 asset |

All routes except `/health` require:

```text
Authorization: Bearer YOUR_ADMIN_TOKEN
```

## Current limitation

Registry pagination may require a source-specific follow-up once the first live index
response is inspected. This version will ingest links exposed by the initial registry
index and all manually seeded profiles. It does not claim complete registry coverage
until pagination behavior is verified.
