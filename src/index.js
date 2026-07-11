
const SOURCE_ID = "cac-zr1-registry";
const SOURCE_BASE = "https://www.corvetteactioncenter.com/specs/c7-corvette/corvette-zr1-registry/";
const INDEX_URL = `${SOURCE_BASE}index.php`;
const PROFILE_PATTERN = /showprofile\.php\?id=([^"'&#<>\s]+)/gi;
const VIN_PATTERN = /\b[1-5][A-HJ-NPR-Z0-9]{16}\b/gi;
const PARTIAL_PATTERN = /\bK580\d{4}\b/gi;
const STICKER_URL_PATTERN =
  /(?:href|src)\s*=\s*["']([^"']*(?:window[\s_-]*sticker|monroney)[^"']*\.(?:jpe?g|png|webp|pdf)(?:\?[^"']*)?)["']/gi;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "vetteintel-ingestion",
          version: "0.2.0",
          source_enabled: env.SOURCE_ENABLED === "true"
        }, 200, env);
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        await requireAdmin(request, env);
        return json(await getStatus(env), 200, env);
      }

      if (url.pathname === "/api/admin/seed" && request.method === "POST") {
        await requireAdmin(request, env);
        const body = await request.json();
        const result = await seedProfiles(env, body?.profiles || []);
        return json({ ok: true, ...result }, 200, env);
      }

      if (url.pathname === "/api/admin/discover" && request.method === "POST") {
        await requireAdmin(request, env);
        const result = await discoverIndex(env);
        return json({ ok: true, ...result }, 200, env);
      }

      if (url.pathname === "/api/admin/run" && request.method === "POST") {
        await requireAdmin(request, env);
        const result = await runBatch(env, "manual");
        return json({ ok: true, ...result }, 200, env);
      }

      if (url.pathname === "/api/assets" && request.method === "GET") {
        await requireAdmin(request, env);
        const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
        const rows = await env.DB.prepare(`
          SELECT asset_id, vin, source_url, content_type, byte_length, sha256,
                 r2_key, status, quality_status, discovered_at, downloaded_at
          FROM sticker_assets
          ORDER BY discovered_at DESC
          LIMIT ?
        `).bind(limit).all();
        return json({ ok: true, assets: rows.results || [] }, 200, env);
      }

      if (url.pathname.startsWith("/api/asset/") && request.method === "GET") {
        await requireAdmin(request, env);
        const assetId = decodeURIComponent(url.pathname.slice("/api/asset/".length));
        return await serveAsset(assetId, env);
      }

      return json({
        ok: false,
        error: "Not found",
        routes: [
          "GET /health",
          "GET /api/status",
          "POST /api/admin/seed",
          "POST /api/admin/discover",
          "POST /api/admin/run",
          "GET /api/assets",
          "GET /api/asset/:assetId"
        ]
      }, 404, env);
    } catch (error) {
      const status = error?.status || 500;
      return json({
        ok: false,
        error: status === 500 ? "Internal error" : error.message,
        details: status === 500 ? String(error?.message || error) : undefined
      }, status, env);
    }
  },

  async scheduled(controller, env, ctx) {
    if (env.SOURCE_ENABLED !== "true") return;
    ctx.waitUntil(runBatch(env, `cron:${controller.cron}`));
  }
};

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    throw httpError(500, "ADMIN_TOKEN secret is not configured.");
  }
  const auth = request.headers.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(supplied, env.ADMIN_TOKEN)) {
    throw httpError(401, "Unauthorized");
  }
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}

async function discoverIndex(env) {
  enforceEnabled(env);
  const response = await sourceFetch(INDEX_URL, env);
  const html = await response.text();

  const urls = new Set();
  for (const match of html.matchAll(PROFILE_PATTERN)) {
    const rawId = match[1];
    const profileUrl = new URL(`showprofile.php?id=${rawId}`, SOURCE_BASE).toString();
    urls.add(profileUrl);
  }

  const inserted = await insertProfileUrls(env, [...urls]);
  return { discovered: urls.size, inserted };
}

async function seedProfiles(env, profiles) {
  if (!Array.isArray(profiles)) throw httpError(400, "profiles must be an array.");
  const valid = [];
  for (const value of profiles) {
    const url = new URL(String(value));
    if (!isAllowedSourceUrl(url)) throw httpError(400, `Disallowed profile URL: ${url}`);
    if (!url.pathname.endsWith("/showprofile.php")) throw httpError(400, `Not a profile URL: ${url}`);
    valid.push(url.toString());
  }
  const inserted = await insertProfileUrls(env, valid);
  return { submitted: valid.length, inserted };
}

async function insertProfileUrls(env, urls) {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const url of urls) {
    const profileId = new URL(url).searchParams.get("id");
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO profiles (
        profile_url, source_id, profile_id, status, discovered_at
      ) VALUES (?, ?, ?, 'queued', ?)
    `).bind(url, SOURCE_ID, profileId, now).run();
    inserted += Number(result.meta?.changes || 0);
  }
  return inserted;
}

async function runBatch(env, triggerType) {
  enforceEnabled(env);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO crawl_runs (run_id, trigger_type, started_at)
    VALUES (?, ?, ?)
  `).bind(runId, triggerType, startedAt).run();

  const batchSize = clampInt(env.BATCH_SIZE, 1, 25, 5);
  const due = await env.DB.prepare(`
    SELECT profile_url, profile_id, attempts
    FROM profiles
    WHERE status IN ('queued', 'retry')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY discovered_at ASC
    LIMIT ?
  `).bind(startedAt, batchSize).all();

  const stats = {
    run_id: runId,
    attempted: 0,
    completed: 0,
    assets_downloaded: 0,
    errors: 0
  };

  for (const profile of due.results || []) {
    stats.attempted++;
    try {
      const result = await processProfile(env, profile);
      stats.completed++;
      stats.assets_downloaded += result.assetsDownloaded;
    } catch (error) {
      stats.errors++;
      await markProfileFailure(env, profile, error);
    }
    await sleep(clampInt(env.SOURCE_DELAY_MS, 0, 10000, 1500));
  }

  const finishedAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE crawl_runs
    SET finished_at = ?, profiles_attempted = ?, profiles_completed = ?,
        assets_downloaded = ?, errors = ?
    WHERE run_id = ?
  `).bind(
    finishedAt, stats.attempted, stats.completed,
    stats.assets_downloaded, stats.errors, runId
  ).run();

  return stats;
}

async function processProfile(env, profile) {
  const response = await sourceFetch(profile.profile_url, env);
  const html = await response.text();
  const now = new Date().toISOString();

  const vin = firstMatch(html, VIN_PATTERN);
  const partialVin = firstMatch(html, PARTIAL_PATTERN);
  const parsed = parseProfileSummary(html);
  const htmlHash = await sha256Hex(new TextEncoder().encode(html));
  const rawHtmlKey = `c7/raw-html/${profile.profile_id || "unknown"}/${htmlHash}.html`;

  await env.STICKERS.put(rawHtmlKey, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      source: SOURCE_ID,
      profileUrl: profile.profile_url,
      vin: vin || ""
    }
  });

  const stickerUrls = extractStickerUrls(html, profile.profile_url);
  let assetsDownloaded = 0;

  for (const assetUrl of stickerUrls) {
    const assetResult = await ingestAsset(env, {
      profileUrl: profile.profile_url,
      vin,
      assetUrl,
      discoveredAt: now
    });
    if (assetResult.downloaded) assetsDownloaded++;
  }

  await env.DB.prepare(`
    UPDATE profiles
    SET vin = COALESCE(?, vin),
        partial_vin = COALESCE(?, partial_vin),
        year = COALESCE(?, year),
        variant = COALESCE(?, variant),
        body_style = COALESCE(?, body_style),
        serial_number = COALESCE(?, serial_number),
        status = ?,
        attempts = attempts + 1,
        processed_at = ?,
        raw_html_key = ?,
        last_error = NULL,
        next_attempt_at = NULL
    WHERE profile_url = ?
  `).bind(
    vin, partialVin, parsed.year, parsed.variant, parsed.bodyStyle,
    parsed.serialNumber,
    stickerUrls.length ? "complete" : "no_sticker",
    now, rawHtmlKey, profile.profile_url
  ).run();

  return { assetsDownloaded, stickerCount: stickerUrls.length };
}

async function ingestAsset(env, input) {
  const existing = await env.DB.prepare(`
    SELECT asset_id, status FROM sticker_assets WHERE source_url = ?
  `).bind(input.assetUrl).first();

  if (existing?.status === "downloaded") {
    return { downloaded: false, duplicate: true, assetId: existing.asset_id };
  }

  const response = await sourceFetch(input.assetUrl, env, true);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!isAllowedAssetType(contentType, input.assetUrl)) {
    throw new Error(`Unsupported sticker content type: ${contentType || "unknown"}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  const maxBytes = clampInt(env.MAX_ASSET_BYTES, 1, 50_000_000, 15_000_000);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Sticker asset exceeds configured maximum: ${contentLength}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Sticker asset exceeds configured maximum: ${bytes.byteLength}`);
  }

  const hash = await sha256Hex(bytes);
  const ext = extensionFor(contentType, input.assetUrl);
  const assetId = hash.slice(0, 24);
  const vinSegment = input.vin || "unknown-vin";
  const r2Key = `c7/raw-stickers/${vinSegment}/${hash}${ext}`;

  const hashDuplicate = await env.DB.prepare(`
    SELECT asset_id, r2_key FROM sticker_assets WHERE sha256 = ?
  `).bind(hash).first();

  if (!hashDuplicate) {
    await env.STICKERS.put(r2Key, bytes, {
      httpMetadata: { contentType: contentType || "application/octet-stream" },
      customMetadata: {
        vin: input.vin || "",
        profileUrl: input.profileUrl,
        sourceUrl: input.assetUrl,
        sha256: hash,
        generation: "C7"
      }
    });
  }

  await env.DB.prepare(`
    INSERT INTO sticker_assets (
      asset_id, profile_url, vin, source_url, content_type, byte_length,
      sha256, r2_key, status, discovered_at, downloaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      vin = excluded.vin,
      content_type = excluded.content_type,
      byte_length = excluded.byte_length,
      sha256 = excluded.sha256,
      r2_key = excluded.r2_key,
      status = 'downloaded',
      downloaded_at = excluded.downloaded_at,
      last_error = NULL
  `).bind(
    assetId, input.profileUrl, input.vin, input.assetUrl, contentType,
    bytes.byteLength, hash, hashDuplicate?.r2_key || r2Key,
    input.discoveredAt, new Date().toISOString()
  ).run();

  return { downloaded: !hashDuplicate, duplicate: Boolean(hashDuplicate), assetId };
}

async function markProfileFailure(env, profile, error) {
  const attempts = Number(profile.attempts || 0) + 1;
  const terminal = attempts >= 5;
  const delayMinutes = Math.min(24 * 60, 2 ** attempts * 15);
  const next = new Date(Date.now() + delayMinutes * 60_000).toISOString();

  await env.DB.prepare(`
    UPDATE profiles
    SET status = ?, attempts = attempts + 1, last_error = ?,
        next_attempt_at = ?
    WHERE profile_url = ?
  `).bind(
    terminal ? "failed" : "retry",
    String(error?.message || error).slice(0, 1000),
    terminal ? null : next,
    profile.profile_url
  ).run();
}

async function serveAsset(assetId, env) {
  const row = await env.DB.prepare(`
    SELECT r2_key, content_type, vin, sha256
    FROM sticker_assets WHERE asset_id = ?
  `).bind(assetId).first();

  if (!row) throw httpError(404, "Asset not found.");
  const object = await env.STICKERS.get(row.r2_key);
  if (!object) throw httpError(404, "R2 object not found.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `inline; filename="${row.vin || "c7"}-${assetId}${extensionFor(row.content_type, row.r2_key)}"`);
  return new Response(object.body, { headers });
}

async function getStatus(env) {
  const [profiles, assets, lastRun] = await Promise.all([
    env.DB.prepare(`
      SELECT status, COUNT(*) AS count FROM profiles GROUP BY status ORDER BY status
    `).all(),
    env.DB.prepare(`
      SELECT status, COUNT(*) AS count FROM sticker_assets GROUP BY status ORDER BY status
    `).all(),
    env.DB.prepare(`
      SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT 1
    `).first()
  ]);

  return {
    ok: true,
    profiles: profiles.results || [],
    assets: assets.results || [],
    last_run: lastRun || null
  };
}

function extractStickerUrls(html, profileUrl) {
  const urls = new Set();
  for (const match of html.matchAll(STICKER_URL_PATTERN)) {
    try {
      const url = new URL(decodeHtml(match[1]), profileUrl);
      if (isAllowedSourceUrl(url)) urls.add(url.toString());
    } catch {}
  }
  return [...urls];
}

function parseProfileSummary(html) {
  const text = stripHtml(html);
  const year = Number(firstMatch(text, /\b(20(?:14|15|16|17|18|19))\b/i)) || null;
  const variant = firstMatch(text, /\b(ZR1|Z06|Grand Sport|Stingray)\b/i);
  const bodyStyle = firstMatch(text, /\b(Coupe|Convertible)\b/i);
  const serialNumber = firstMatch(text, /Serial\s*#?\s*(\d+)/i);
  return {
    year,
    variant: variant ? normalizeVariant(variant) : null,
    bodyStyle: bodyStyle ? titleCase(bodyStyle) : null,
    serialNumber
  };
}

async function sourceFetch(url, env, asset = false) {
  const parsed = new URL(url);
  if (!isAllowedSourceUrl(parsed)) throw new Error(`Disallowed source URL: ${parsed}`);

  const response = await fetch(parsed.toString(), {
    headers: {
      "user-agent": "VetteIntel-C7-Sticker-Research/0.2 (+https://www.corvette-web-central.com/)",
      "accept": asset
        ? "application/pdf,image/jpeg,image/png,image/webp,*/*;q=0.5"
        : "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) throw new Error(`Source HTTP ${response.status}: ${parsed}`);
  return response;
}

function isAllowedSourceUrl(url) {
  return url.protocol === "https:" &&
    (url.hostname === "www.corvetteactioncenter.com" ||
     url.hostname === "corvetteactioncenter.com") &&
    url.pathname.startsWith("/specs/c7-corvette/corvette-zr1-registry/");
}

function isAllowedAssetType(contentType, url) {
  if (/^(image\/jpeg|image\/png|image\/webp|application\/pdf)$/i.test(contentType)) return true;
  return /\.(jpe?g|png|webp|pdf)(?:\?|$)/i.test(url);
}

function extensionFor(contentType, url) {
  if (contentType === "application/pdf") return ".pdf";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  const match = String(url).match(/\.(jpe?g|png|webp|pdf)(?:\?|$)/i);
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : ".bin";
}

function firstMatch(input, regex) {
  regex.lastIndex = 0;
  const match = regex.exec(String(input || ""));
  if (!match) return null;
  return (match[1] || match[0]).trim().toUpperCase();
}

function normalizeVariant(value) {
  const upper = value.toUpperCase();
  if (upper === "GRAND SPORT") return "Grand Sport";
  if (upper === "STINGRAY") return "Stingray";
  return upper;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function stripHtml(html) {
  return decodeHtml(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function enforceEnabled(env) {
  if (env.SOURCE_ENABLED !== "true") throw httpError(503, "Source harvesting is disabled.");
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(payload, status, env) {
  return cors(new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  }), env);
}

function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", env.ADMIN_ORIGIN || "*");
  headers.set("access-control-allow-headers", "authorization,content-type");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

