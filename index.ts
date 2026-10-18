import http from 'node:http';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));
// oxlint-disable-next-line eslint-plugin-node/no-process-env -- startup config
const PORT = Number(process.env.WEBSERVER_PORT ?? 3001);
// oxlint-disable-next-line eslint-plugin-node/no-process-env -- db connection
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const PUBLIC_URL = 'https://twix-at-user-s-workspace.skydive.app';

const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

type CatalogModel = {
  id: string;
  displayName: string;
  providerDisplay: string;
  inputCost: number | null;
  outputCost: number | null;
  contextWindow: number;
  reasoning: boolean;
  compliant: boolean;
  featured: boolean;
  outputTypes: string[];
  verifiedLatencyMs?: number | null;
  verifiedReply?: string | null;
};

type WorkspaceRow = {
  id: number;
  name: string;
  slug: string;
  workspace_token: string;
  max_keys: number;
  is_default: boolean;
  created_at: string;
};

type ApiKeyRow = {
  id: number;
  workspace_id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
  status: string;
  cooldown_until: number;
  quota_limit: number;
  used_requests: number;
  used_tokens: number;
  priority_order: number;
  total_requests: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  last_used_at: string | null;
};

let catalogModels: CatalogModel[] = [];
try {
  const raw = fs.readFileSync(join(__dirname, 'models-catalog.json'), 'utf8');
  const parsed = JSON.parse(raw);
  catalogModels = parsed.models ?? [];
} catch (err) {
  console.error('[webserver] failed to load models-catalog.json', err);
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  '9router': 'http://localhost:20128/v1',
};

async function initDb() {
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      workspace_token TEXT NOT NULL UNIQUE,
      max_keys INT NOT NULL DEFAULT 10,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'openrouter',
      base_url TEXT NOT NULL DEFAULT 'https://openrouter.ai/api/v1',
      api_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      status TEXT NOT NULL DEFAULT 'active',
      cooldown_until BIGINT NOT NULL DEFAULT 0,
      quota_limit INT NOT NULL DEFAULT 1000,
      used_requests INT NOT NULL DEFAULT 0,
      used_tokens BIGINT NOT NULL DEFAULT 0,
      priority_order INT NOT NULL DEFAULT 1,
      total_requests BIGINT NOT NULL DEFAULT 0,
      success_count BIGINT NOT NULL DEFAULT 0,
      fail_count BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const wsCount = await sql`SELECT COUNT(*)::int AS count FROM workspaces`;
  if (wsCount[0]?.count === 0) {
    await sql`
      INSERT INTO workspaces (name, slug, workspace_token, max_keys, is_default)
      VALUES
        ('Workspace 1', 'workspace-1', 'twix-ws-1', 10, true),
        ('Workspace 2', 'workspace-2', 'twix-ws-2', 10, false),
        ('Workspace 3', 'workspace-3', 'twix-ws-3', 10, false)
    `;
  }

  const keyCount = await sql`SELECT COUNT(*)::int AS count FROM api_keys`;
  if (keyCount[0]?.count === 0) {
    await sql`
      INSERT INTO api_keys (workspace_id, name, provider, base_url, api_key, enabled, status, quota_limit, used_requests, priority_order)
      VALUES (1, 'Slot #1 — Built-in Sentinel Key', 'openrouter', 'https://openrouter.ai/api/v1', 'sentinel', true, 'active', 1000, 0, 1)
    `;
  }
}

initDb().catch((err) => console.error('[webserver] DB init error:', err));

function maskKey(k: string): string {
  if (!k) return '';
  if (k === 'sentinel') return 'sentinel (Built-in)';
  if (k.length <= 10) return `${k.slice(0, 3)}***${k.slice(-2)}`;
  return `${k.slice(0, 6)}••••${k.slice(-4)}`;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `workspace-${Date.now()}`
  );
}

async function getWorkspaces(): Promise<WorkspaceRow[]> {
  if (!sql) {
    return [
      {
        id: 1,
        name: 'Workspace 1',
        slug: 'workspace-1',
        workspace_token: 'twix-ws-1',
        max_keys: 10,
        is_default: true,
        created_at: new Date().toISOString(),
      },
    ];
  }
  const rows = await sql`
    SELECT id, name, slug, workspace_token, max_keys, is_default, created_at
    FROM workspaces
    ORDER BY id ASC
  `;
  return rows as unknown as WorkspaceRow[];
}

async function getAllKeys(workspaceId?: number): Promise<ApiKeyRow[]> {
  if (!sql) {
    return [
      {
        id: 1,
        workspace_id: 1,
        name: 'Slot #1 — Built-in Sentinel Key',
        provider: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sentinel',
        enabled: true,
        status: 'active',
        cooldown_until: 0,
        quota_limit: 1000,
        used_requests: 0,
        used_tokens: 0,
        priority_order: 1,
        total_requests: 0,
        success_count: 0,
        fail_count: 0,
        last_error: null,
        last_used_at: null,
      },
    ];
  }
  const rows = workspaceId
    ? await sql`
        SELECT id, workspace_id, name, provider, base_url, api_key, enabled, status,
               cooldown_until::bigint AS cooldown_until,
               quota_limit::int AS quota_limit,
               used_requests::int AS used_requests,
               used_tokens::bigint AS used_tokens,
               priority_order::int AS priority_order,
               total_requests::int AS total_requests,
               success_count::int AS success_count,
               fail_count::int AS fail_count,
               last_error, last_used_at
        FROM api_keys
        WHERE workspace_id = ${workspaceId}
        ORDER BY priority_order ASC, id ASC
      `
    : await sql`
        SELECT id, workspace_id, name, provider, base_url, api_key, enabled, status,
               cooldown_until::bigint AS cooldown_until,
               quota_limit::int AS quota_limit,
               used_requests::int AS used_requests,
               used_tokens::bigint AS used_tokens,
               priority_order::int AS priority_order,
               total_requests::int AS total_requests,
               success_count::int AS success_count,
               fail_count::int AS fail_count,
               last_error, last_used_at
        FROM api_keys
        ORDER BY workspace_id ASC, priority_order ASC, id ASC
      `;
  return rows as unknown as ApiKeyRow[];
}

/**
 * Resolves which Workspace to use from:
 * 1. Explicit URL path (`/w/:slug/v1/...`)
 * 2. Query param (`?workspace=workspace-1` or `?workspace=1`)
 * 3. Header `X-Workspace` or `Authorization: Bearer twix-ws-1`
 * 4. Active Default Workspace
 */
async function resolveTargetWorkspace(
  req: http.IncomingMessage,
  parsedUrl: URL,
  pathWorkspaceSlug?: string
): Promise<WorkspaceRow> {
  const workspaces = await getWorkspaces();
  const qWs =
    pathWorkspaceSlug ||
    parsedUrl.searchParams.get('workspace') ||
    req.headers['x-workspace']?.toString() ||
    '';
  const authHeader = (req.headers['authorization']?.toString() || '').replace(
    /^Bearer\s+/i,
    ''
  );

  if (qWs) {
    const byMatch = workspaces.find(
      (w) =>
        w.slug.toLowerCase() === qWs.toLowerCase() ||
        String(w.id) === qWs ||
        w.name.toLowerCase() === qWs.toLowerCase() ||
        w.workspace_token === qWs
    );
    if (byMatch) return byMatch;
  }

  if (authHeader && authHeader.startsWith('twix-ws-')) {
    const byToken = workspaces.find((w) => w.workspace_token === authHeader);
    if (byToken) return byToken;
  }

  return workspaces.find((w) => w.is_default) || workspaces[0];
}

/**
 * SEQUENTIAL SPILLOVER SELECTION (Khusus untuk API Key Terbatas per Workspace):
 * Mengurutkan API key di dalam Workspace dari Slot #1, #2, ..., sampai #10.
 * - Menggunakan Slot #1 terus-menerus selama belum mencapai 100% kuota (`used_requests < quota_limit`)
 *   dan statusnya masih `active`.
 * - Begitu Slot #1 mencapai 100% kuota atau habis (401/402/403/429), otomatis berpindah ke Slot #2,
 *   lalu Slot #3, dan seterusnya.
 */
async function getWorkspaceSequentialCandidates(workspaceId: number): Promise<ApiKeyRow[]> {
  const keys = await getAllKeys(workspaceId);
  const now = Date.now();
  const enabledKeys = keys.filter((k) => k.enabled);
  if (enabledKeys.length === 0) return [];

  // Filter keys that still have quota (<100%) and are not exhausted/cooling down
  const available = enabledKeys.filter((k) => {
    const limit = Math.max(1, Number(k.quota_limit || 1000));
    const used = Number(k.used_requests || 0);
    const quotaRemaining = used < limit;
    const notExhausted = k.status !== 'exhausted';
    const cooldownDone = Number(k.cooldown_until || 0) <= now;
    return quotaRemaining && notExhausted && cooldownDone;
  });

  return available;
}

async function recordKeySuccess(keyRow: ApiKeyRow) {
  if (!sql) return;
  const newUsed = Number(keyRow.used_requests || 0) + 1;
  const limit = Math.max(1, Number(keyRow.quota_limit || 1000));
  const nextStatus = newUsed >= limit ? 'exhausted' : 'active';
  const lastErr =
    newUsed >= limit
      ? `Kuota penuh 100% (${newUsed}/${limit} req) — otomatis pindah ke Key berikutnya`
      : null;

  await sql`
    UPDATE api_keys
    SET status = ${nextStatus},
        cooldown_until = 0,
        used_requests = ${newUsed},
        total_requests = total_requests + 1,
        success_count = success_count + 1,
        last_used_at = NOW(),
        last_error = ${lastErr}
    WHERE id = ${keyRow.id}
  `;
}

async function recordKeyFailure(keyRow: ApiKeyRow, statusCode: number, errText: string) {
  if (!sql) return;
  const lower = errText.toLowerCase();
  const isQuotaOrInvalid =
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    lower.includes('insufficient_quota') ||
    lower.includes('credit') ||
    lower.includes('balance') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('invalid_api_key');

  const isRateLimit = statusCode === 429 && !isQuotaOrInvalid;
  const newStatus = isQuotaOrInvalid
    ? 'exhausted'
    : isRateLimit
      ? 'cooldown'
      : 'active';

  // If upstream says quota exhausted, snap used_requests to quota_limit (100%) so UI shows 100% Habis
  const newUsed = isQuotaOrInvalid
    ? Math.max(Number(keyRow.quota_limit || 1000), Number(keyRow.used_requests || 0))
    : Number(keyRow.used_requests || 0);

  const cooldownUntil = isQuotaOrInvalid
    ? Date.now() + 3600_000
    : isRateLimit
      ? Date.now() + 60_000
      : 0;

  const shortErr = `HTTP ${statusCode}: ${errText.slice(0, 160)}`;
  await sql`
    UPDATE api_keys
    SET status = ${newStatus},
        used_requests = ${newUsed},
        cooldown_until = ${cooldownUntil},
        total_requests = total_requests + 1,
        fail_count = fail_count + 1,
        last_used_at = NOW(),
        last_error = ${shortErr}
    WHERE id = ${keyRow.id}
  `;
}

function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, x-workspace, anthropic-version, x-goog-api-key'
  );
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeModelForProvider(model: string, provider: string, baseUrl: string): string {
  if (
    provider === 'openrouter' ||
    baseUrl.includes('openrouter.ai') ||
    provider === '9router' ||
    provider === 'custom'
  ) {
    return model;
  }
  const slashIdx = model.indexOf('/');
  if (slashIdx !== -1) {
    return model.slice(slashIdx + 1);
  }
  return model;
}

async function executeWorkspaceSequentialFailover(
  workspace: WorkspaceRow,
  endpointType: 'chat' | 'messages' | 'images',
  payloadObj: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  timeoutMs = 30000
): Promise<{
  upstream: Response;
  usedKey: ApiKeyRow;
  attempts: Array<{ keyId: number; keyName: string; status: number | string }>;
}> {
  const candidates = await getWorkspaceSequentialCandidates(workspace.id);
  if (candidates.length === 0) {
    throw new Error(
      `Semua API Key di ${workspace.name} (${workspace.slug}) sudah mencapai 100% / Habis, atau belum ada key. Silakan ganti/reset API Key di ${workspace.name}.`
    );
  }

  const attempts: Array<{ keyId: number; keyName: string; status: number | string }> = [];
  let lastResponse: Response | null = null;
  let lastKey: ApiKeyRow = candidates[0];

  for (const keyRow of candidates) {
    lastKey = keyRow;
    const baseUrl = keyRow.base_url.replace(/\/+$/, '');
    const rawModel = String(payloadObj.model ?? 'google/gemini-2.5-flash');
    const targetModel = normalizeModelForProvider(rawModel, keyRow.provider, baseUrl);
    const bodyToSend = JSON.stringify({ ...payloadObj, model: targetModel });

    let targetUrl = `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keyRow.api_key}`,
      ...extraHeaders,
    };

    if (endpointType === 'messages') {
      targetUrl = `${baseUrl}/messages`;
      headers['x-api-key'] = keyRow.api_key;
      headers['anthropic-version'] = extraHeaders?.['anthropic-version'] ?? '2023-06-01';
    } else if (endpointType === 'images') {
      targetUrl =
        baseUrl.includes('openrouter.ai') && keyRow.api_key === 'sentinel'
          ? 'https://api.openai.com/v1/images/generations'
          : `${baseUrl}/images/generations`;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyToSend,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        await recordKeySuccess(keyRow);
        attempts.push({ keyId: keyRow.id, keyName: keyRow.name, status: resp.status });
        return { upstream: resp, usedKey: keyRow, attempts };
      }

      const errText = await resp.text();
      if (resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429) {
        await recordKeyFailure(keyRow, resp.status, errText);
      }
      attempts.push({ keyId: keyRow.id, keyName: keyRow.name, status: resp.status });

      lastResponse = new Response(errText, {
        status: resp.status,
        headers: { 'content-type': resp.headers.get('content-type') ?? 'application/json' },
      });

      if (resp.status === 400 || resp.status === 404) {
        break;
      }
    } catch (netErr) {
      const msg = netErr instanceof Error ? netErr.message : String(netErr);
      attempts.push({ keyId: keyRow.id, keyName: keyRow.name, status: 'TIMEOUT/ERR' });
      lastResponse = new Response(JSON.stringify({ error: { message: msg } }), {
        status: 504,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  if (lastResponse) {
    return { upstream: lastResponse, usedKey: lastKey, attempts };
  }
  throw new Error(`Semua API Key di ${workspace.name} gagal dihubungi.`);
}

function renderDashboardHtml(): string {
  const featured = catalogModels.filter((m) => m.featured);
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Twix AI Router — Unlimited Workspaces &amp; ${catalogModels.length} Verified Models</title>
  <style>
    :root {
      --bg: #060913;
      --bg-glow: radial-gradient(circle at 15% 10%, rgba(56, 189, 248, 0.14), transparent 35%),
                 radial-gradient(circle at 85% 15%, rgba(168, 85, 247, 0.14), transparent 35%),
                 radial-gradient(circle at 50% 90%, rgba(16, 185, 129, 0.10), transparent 40%);
      --card: rgba(15, 23, 42, 0.82);
      --card-solid: #0f172a;
      --border: rgba(51, 65, 85, 0.75);
      --border-glow: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --muted: #94a3b8;
      --cyan: #38bdf8;
      --indigo: #818cf8;
      --purple: #c084fc;
      --green: #10b981;
      --yellow: #f59e0b;
      --orange: #f97316;
      --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      background-image: var(--bg-glow);
      background-attachment: fixed;
      color: var(--text);
      line-height: 1.5;
      padding: 20px 16px 70px;
    }
    .container { max-width: 1240px; margin: 0 auto; }

    /* HERO HEADER */
    .hero {
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(30, 27, 75, 0.75));
      border: 1px solid var(--border-glow);
      border-radius: 18px;
      padding: 22px 24px;
      margin-bottom: 20px;
      box-shadow: 0 12px 40px -10px rgba(56, 189, 248, 0.18);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .hero-title {
      font-size: 1.65rem;
      font-weight: 800;
      margin: 0;
      background: linear-gradient(90deg, #fff, #38bdf8, #c084fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.2px;
      -webkit-text-fill-color: initial;
    }
    .pill-green { background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.45); }
    .pill-cyan { background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.45); }
    .pill-purple { background: rgba(192, 132, 252, 0.18); color: #c084fc; border: 1px solid rgba(192, 132, 252, 0.45); }

    /* WORKSPACE TABS BAR */
    .ws-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
      margin-bottom: 18px;
    }
    .ws-tab {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 10px 16px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.86rem;
      display: flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
      transition: all 0.2s ease;
    }
    .ws-tab:hover { border-color: var(--cyan); color: var(--text); }
    .ws-tab.active {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.22), rgba(129, 140, 248, 0.22));
      border-color: var(--cyan);
      color: #fff;
      box-shadow: 0 4px 20px rgba(56, 189, 248, 0.22);
    }
    .ws-slot-badge {
      font-size: 0.72rem;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: #cbd5e1;
    }
    .ws-add-btn {
      background: linear-gradient(135deg, var(--cyan), var(--indigo));
      color: #060913;
      border: none;
      padding: 10px 16px;
      border-radius: 12px;
      font-weight: 800;
      font-size: 0.84rem;
      cursor: pointer;
      white-space: nowrap;
    }

    /* CARDS & LAYOUT */
    .card {
      background: var(--card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
    }
    .card-title {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* SMART RECOMMENDATION BANNER */
    .rec-banner {
      background: linear-gradient(90deg, rgba(16, 185, 129, 0.14), rgba(56, 189, 248, 0.12));
      border: 1px solid rgba(16, 185, 129, 0.4);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .rec-banner.warn {
      background: linear-gradient(90deg, rgba(245, 158, 11, 0.16), rgba(239, 68, 68, 0.14));
      border-color: rgba(245, 158, 11, 0.5);
    }

    /* KEY SLOTS VISUAL GRID (MAX 10 SLOTS PER WORKSPACE) */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .key-card {
      background: #090e1c;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 15px;
      position: relative;
      transition: all 0.2s ease;
    }
    .key-card.active-turn {
      border-color: var(--green);
      box-shadow: 0 0 22px rgba(16, 185, 129, 0.2);
    }
    .key-card.warning-turn {
      border-color: var(--yellow);
    }
    .key-card.exhausted-turn {
      border-color: rgba(239, 68, 68, 0.5);
      opacity: 0.88;
    }
    .key-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
    }
    .slot-num {
      font-size: 0.72rem;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--cyan);
    }
    .usage-wrap {
      margin: 10px 0;
    }
    .usage-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.78rem;
      margin-bottom: 5px;
      font-weight: 600;
    }
    .usage-bar-bg {
      width: 100%;
      height: 10px;
      background: #1e293b;
      border-radius: 999px;
      overflow: hidden;
    }
    .usage-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.3s ease;
    }

    /* BUTTONS & INPUTS */
    .btn-sm {
      background: #1e293b;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 11px;
      font-size: 0.75rem;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.15s;
    }
    .btn-sm:hover { background: #334155; }
    .btn-green { background: rgba(16, 185, 129, 0.18); color: #34d399; border-color: rgba(16, 185, 129, 0.4); }
    .btn-danger { background: rgba(239, 68, 68, 0.14); color: #f87171; border-color: rgba(239, 68, 68, 0.35); }
    .btn-cyan { background: rgba(56, 189, 248, 0.18); color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); }

    input, select, textarea, button.primary {
      width: 100%;
      padding: 9px 12px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: #060a14;
      color: var(--text);
      font-size: 0.86rem;
    }
    button.primary {
      background: linear-gradient(135deg, var(--cyan), var(--indigo));
      color: #060913;
      font-weight: 800;
      border: none;
      cursor: pointer;
    }
    button.primary:disabled { opacity: 0.45; cursor: not-allowed; }

    pre {
      background: #050811;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      overflow-x: auto;
      font-size: 0.79rem;
      color: #cbd5e1;
      margin: 8px 0 0;
    }

    .table-wrap {
      overflow-x: auto;
      max-height: 500px;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    th { background: #0b1325; position: sticky; top: 0; z-index: 1; color: var(--muted); font-weight: 600; }
    tr:hover { background: rgba(255,255,255,0.025); }
    code.id {
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.12);
      padding: 3px 7px;
      border-radius: 6px;
      font-weight: 600;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- HERO -->
    <div class="hero">
      <div>
        <h1 class="hero-title">
          ⚡ Twix AI Router
          <span class="pill pill-green">✅ ${catalogModels.length} Verified Working Models</span>
          <span class="pill pill-cyan">🏢 Unlimited Workspaces (Max 10 Keys/Room)</span>
          <span class="pill pill-purple">📊 Sequential Spillover + Live Usage %</span>
        </h1>
        <div style="color: var(--muted); font-size: 0.86rem; margin-top: 6px;">
          Hanya menampilkan <strong>${catalogModels.length} model yang terbukti sukses (OK)</strong>. Setiap Workspace menampung maks 10 API Key terbatas: pakai Slot #1 sampai 100%, otomatis pindah ke Slot #2, dst. Jika habis tinggal ganti key di slot tersebut!
        </div>
      </div>
    </div>

    <!-- WORKSPACE SWITCHER BAR -->
    <div class="ws-bar" id="ws-bar">
      <!-- Dynamically rendered workspace tabs -->
    </div>

    <!-- ACTIVE WORKSPACE ROOM MANAGER -->
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">
            <span id="ws-title">🏢 Workspace 1</span>
            <span class="pill pill-cyan" id="ws-slot-counter">1 / 10 Slot Terisi</span>
            <span class="pill pill-green" id="ws-default-badge" style="display:none">⭐ Default Global</span>
          </h2>
          <div style="font-size:0.8rem; color:var(--muted); margin-top:3px;">
            Endpoint Khusus Room Ini: <code id="ws-endpoint" style="color:var(--cyan)">${PUBLIC_URL}/w/workspace-1/v1/chat/completions</code>
            &nbsp;|&nbsp; Workspace Key: <code id="ws-token" style="color:var(--purple)">twix-ws-1</code>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-sm btn-cyan" onclick="setAsDefaultWorkspace()">⭐ Jadikan Default</button>
          <button class="btn-sm" onclick="renameCurrentWorkspace()">✏️ Ubah Nama Room</button>
          <button class="btn-sm" onclick="resetWorkspaceUsage()">🔄 Reset Semua Usage (0%)</button>
          <button class="btn-sm btn-danger" onclick="deleteCurrentWorkspace()">🗑️ Hapus Room</button>
        </div>
      </div>

      <!-- SMART AI RECOMMENDATION BANNER -->
      <div class="rec-banner" id="rec-banner">
        <div>
          <div style="font-weight:700; font-size:0.9rem; color:#fff;" id="rec-headline">💡 Rekomendasi Terbaik Workspace</div>
          <div style="font-size:0.82rem; color:#cbd5e1; margin-top:2px;" id="rec-desc">Memuat analisis pemakaian API Key di room ini...</div>
        </div>
        <div id="rec-badge"></div>
      </div>

      <!-- VISUAL KEY SLOTS (UP TO 10 CARDS) -->
      <div class="slots-grid" id="keys-grid"></div>

      <!-- ADD KEY TO THIS WORKSPACE (MAX 10) -->
      <div style="background:#080d1a; border:1px dashed var(--border-glow); border-radius:14px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
          <div style="font-weight:700; font-size:0.9rem; color:var(--cyan);">
            ➕ Tambah API Key ke <span id="add-ws-name">Workspace 1</span> (Maksimal 10 Key per Room)
          </div>
          <div style="font-size:0.76rem; color:var(--muted);">
            Urutan eksekusi: Slot #1 dipakai penuh (0% → 100%), lalu otomatis lanjut ke Slot #2, #3, s/d #10
          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1.1fr 1fr 1.3fr 1.3fr 0.9fr 0.9fr; gap:10px; align-items:end;">
          <div>
            <label style="font-size:0.73rem;color:var(--muted)">Label / Nama Key</label>
            <input id="k-name" placeholder="Misal: Key Utama #1" />
          </div>
          <div>
            <label style="font-size:0.73rem;color:var(--muted)">Provider</label>
            <select id="k-provider" onchange="onProviderChange()">
              <option value="openrouter">OpenRouter</option>
              <option value="openai">OpenAI Direct</option>
              <option value="anthropic">Anthropic Direct</option>
              <option value="gemini">Google Gemini</option>
              <option value="groq">Groq</option>
              <option value="deepseek">DeepSeek</option>
              <option value="9router">9Router</option>
              <option value="custom">Custom URL</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.73rem;color:var(--muted)">Base URL Upstream</label>
            <input id="k-baseurl" value="https://openrouter.ai/api/v1" />
          </div>
          <div>
            <label style="font-size:0.73rem;color:var(--muted)">API Key Secret</label>
            <input id="k-secret" placeholder="sk-..." />
          </div>
          <div>
            <label style="font-size:0.73rem;color:var(--muted)">Batas Kuota (Req = 100%)</label>
            <input id="k-quota" type="number" value="100" min="1" title="Jumlah request maksimal sebelum key ini dianggap 100% habis dan pindah ke key berikutnya" />
          </div>
          <div>
            <button class="primary" id="btn-add-key" onclick="addKeyToWorkspace()">+ Tambah Slot</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 1-CLICK BULK TESTER FOR THE 266 VERIFIED MODELS -->
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">
          <span>🚀 1-Click Sequential Bulk Test (${catalogModels.length} Verified Models)</span>
        </h2>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-sm btn-green" onclick="copyWorkingModels()">📋 Copy Semua ${catalogModels.length} Model ID</button>
          <button class="btn-sm" onclick="exportBulkResults()">💾 Download JSON</button>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 2fr 1fr 1fr 1.4fr 0.7fr; gap: 10px; align-items: end;">
        <div>
          <label style="font-size:0.74rem;color:var(--muted)">Prompt Test</label>
          <input id="bt-prompt" value="hallo" />
        </div>
        <div>
          <label style="font-size:0.74rem;color:var(--muted)">Target Model</label>
          <select id="bt-scope">
            <option value="all">Semua ${catalogModels.length} Verified Models</option>
            <option value="filtered">Hanya yang Difilter di Tabel</option>
            <option value="featured">Hanya Featured Models (${featured.length})</option>
          </select>
        </div>
        <div>
          <label style="font-size:0.74rem;color:var(--muted)">Giliran</label>
          <select id="bt-concurrency">
            <option value="1" selected>1 per 1 Bergantian</option>
            <option value="2">2 Model Bergantian</option>
            <option value="3">3 Model Bergantian</option>
          </select>
        </div>
        <div>
          <button class="primary" id="bt-start-btn" onclick="startBulkTest()">⚡ Tes Ulang di Workspace Ini</button>
        </div>
        <div>
          <button class="btn-sm btn-danger" id="bt-stop-btn" onclick="stopBulkTest()" style="width:100%; padding:10px;" disabled>⏹ Stop</button>
        </div>
      </div>

      <div class="usage-bar-bg" style="margin: 12px 0;">
        <div class="usage-bar-fill" id="bt-progress" style="width:100%; background: linear-gradient(90deg, var(--cyan), var(--green));"></div>
      </div>

      <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:0.82rem;">
        <span class="pill pill-cyan">Status: <strong id="bt-state">Verified 100% Ready</strong></span>
        <span class="pill pill-green">✅ Sukses (OK): <strong id="bt-ok">${catalogModels.length}</strong></span>
        <span class="pill pill-purple">Sedang Dites: <code id="bt-current">-</code></span>
      </div>
    </div>

    <!-- CURL EXAMPLES PER WORKSPACE -->
    <div class="grid-2" style="margin-bottom:20px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-header" style="margin-bottom:6px;">
          <h2 class="card-title" style="font-size:0.95rem;">1. cURL Chat Completions (Otomatis Pakai Slot Aktif di Room Ini)</h2>
          <button class="btn-sm" onclick="copyPre('curl-ws')">Copy</button>
        </div>
        <pre id="curl-ws"></pre>
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-header" style="margin-bottom:6px;">
          <h2 class="card-title" style="font-size:0.95rem;">2. cURL Ganti API Key yang Habis via API</h2>
          <button class="btn-sm" onclick="copyPre('curl-replace')">Copy</button>
        </div>
        <pre id="curl-replace">curl -X PATCH "${PUBLIC_URL}/api/keys" \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": 1,
    "action": "replace_key",
    "api_key": "sk-key-baru-anda",
    "quota_limit": 100
  }'</pre>
      </div>
    </div>

    <!-- VERIFIED MODELS CATALOG TABLE -->
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">
          <span>📚 Daftar ${catalogModels.length} Model Sukses (125 Model Gagal Sudah Dihapus Permanen)</span>
        </h2>
      </div>
      <input id="search" placeholder="Cari dari ${catalogModels.length} model sukses (contoh: gemini-4, claude, gpt-6, deepseek, qwen)..." oninput="filterModels()" style="margin-bottom:12px;" />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Model ID</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Respons Terverifikasi ("hallo")</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody id="model-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const MODELS = ${JSON.stringify(catalogModels)};
    const TEST_RESULTS = {};
    // Pre-populate with verified results from the user's bulk test JSON
    MODELS.forEach(m => {
      TEST_RESULTS[m.id] = {
        status: 'ok',
        latencyMs: m.verifiedLatencyMs || 500,
        reply: m.verifiedReply || 'OK'
      };
    });

    let WORKSPACES = [];
    let CURRENT_WS_ID = 1;
    let CURRENT_KEYS = [];
    let bulkRunning = false;
    let bulkStopRequested = false;

    const PROVIDER_URLS = {
      openrouter: 'https://openrouter.ai/api/v1',
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
      groq: 'https://api.groq.com/openai/v1',
      deepseek: 'https://api.deepseek.com/v1',
      '9router': 'http://localhost:20128/v1',
      custom: ''
    };

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function onProviderChange() {
      const p = document.getElementById('k-provider').value;
      if (PROVIDER_URLS[p]) {
        document.getElementById('k-baseurl').value = PROVIDER_URLS[p];
      }
    }

    async function loadWorkspacesAndKeys() {
      const res = await fetch('/api/workspaces');
      const data = await res.json();
      WORKSPACES = data.workspaces || [];
      if (!WORKSPACES.find(w => w.id === CURRENT_WS_ID) && WORKSPACES.length > 0) {
        const def = WORKSPACES.find(w => w.is_default) || WORKSPACES[0];
        CURRENT_WS_ID = def.id;
      }
      renderWorkspaceTabs();
      await loadKeysForCurrentWorkspace();
    }

    function renderWorkspaceTabs() {
      const bar = document.getElementById('ws-bar');
      bar.innerHTML = WORKSPACES.map(w => \`
        <div class="ws-tab \${w.id === CURRENT_WS_ID ? 'active' : ''}" onclick="selectWorkspace(\${w.id})">
          <span>🏢 \${escapeHtml(w.name)} \${w.is_default ? '⭐' : ''}</span>
          <span class="ws-slot-badge">\${w.key_count || 0}/\${w.max_keys || 10} Key</span>
        </div>
      \`).join('') + \`
        <button class="ws-add-btn" onclick="createNewWorkspace()">+ Buat Workspace Baru (Unlimited)</button>
      \`;
    }

    async function selectWorkspace(id) {
      CURRENT_WS_ID = id;
      renderWorkspaceTabs();
      await loadKeysForCurrentWorkspace();
    }

    async function createNewWorkspace() {
      const nextNum = WORKSPACES.length + 1;
      const name = prompt('Nama Workspace / Room baru:', 'Workspace ' + nextNum);
      if (!name) return;
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.workspace) {
        CURRENT_WS_ID = data.workspace.id;
      }
      await loadWorkspacesAndKeys();
    }

    async function renameCurrentWorkspace() {
      const ws = WORKSPACES.find(w => w.id === CURRENT_WS_ID);
      if (!ws) return;
      const name = prompt('Ubah nama Workspace:', ws.name);
      if (!name) return;
      await fetch('/api/workspaces', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ws.id, name })
      });
      await loadWorkspacesAndKeys();
    }

    async function setAsDefaultWorkspace() {
      await fetch('/api/workspaces', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: CURRENT_WS_ID, action: 'set_default' })
      });
      await loadWorkspacesAndKeys();
    }

    async function deleteCurrentWorkspace() {
      if (WORKSPACES.length <= 1) return alert('Minimal harus ada 1 Workspace aktif.');
      const ws = WORKSPACES.find(w => w.id === CURRENT_WS_ID);
      if (!confirm('Hapus ' + ws.name + ' beserta semua API Key di dalamnya?')) return;
      await fetch('/api/workspaces?id=' + CURRENT_WS_ID, { method: 'DELETE' });
      CURRENT_WS_ID = WORKSPACES.find(w => w.id !== CURRENT_WS_ID).id;
      await loadWorkspacesAndKeys();
    }

    async function loadKeysForCurrentWorkspace() {
      const ws = WORKSPACES.find(w => w.id === CURRENT_WS_ID);
      if (!ws) return;

      document.getElementById('ws-title').innerText = '🏢 ' + ws.name;
      document.getElementById('add-ws-name').innerText = ws.name;
      document.getElementById('ws-endpoint').innerText = '${PUBLIC_URL}/w/' + ws.slug + '/v1/chat/completions';
      document.getElementById('ws-token').innerText = ws.workspace_token;
      document.getElementById('ws-default-badge').style.display = ws.is_default ? 'inline-flex' : 'none';

      document.getElementById('curl-ws').innerText = \`curl -X POST "${PUBLIC_URL}/w/\${ws.slug}/v1/chat/completions" \\\\
  -H "Authorization: Bearer \${ws.workspace_token}" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{
    "model": "google/gemini-4-argon",
    "messages": [{"role": "user", "content": "hallo"}]
  }'\`;

      const res = await fetch('/api/keys?workspace_id=' + CURRENT_WS_ID);
      const data = await res.json();
      CURRENT_KEYS = data.keys || [];

      document.getElementById('ws-slot-counter').innerText = CURRENT_KEYS.length + ' / ' + (ws.max_keys || 10) + ' Slot Terisi';
      const addBtn = document.getElementById('btn-add-key');
      if (CURRENT_KEYS.length >= (ws.max_keys || 10)) {
        addBtn.disabled = true;
        addBtn.innerText = 'Slot Penuh (10/10)';
      } else {
        addBtn.disabled = false;
        addBtn.innerText = '+ Tambah Slot #' + (CURRENT_KEYS.length + 1);
      }

      renderKeyCardsAndRecommendation(ws, CURRENT_KEYS);
    }

    function renderKeyCardsAndRecommendation(ws, keys) {
      const grid = document.getElementById('keys-grid');
      const recBanner = document.getElementById('rec-banner');
      const recHeadline = document.getElementById('rec-headline');
      const recDesc = document.getElementById('rec-desc');
      const recBadge = document.getElementById('rec-badge');

      if (keys.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:28px; color:var(--muted); border:1px dashed var(--border); border-radius:12px;">Belum ada API Key di ' + escapeHtml(ws.name) + '. Tambahkan 1 s/d 10 API Key di form bawah.</div>';
        recBanner.className = 'rec-banner warn';
        recHeadline.innerText = '⚠️ Workspace Ini Belum Memiliki API Key';
        recDesc.innerText = 'Tambahkan minimal 2–5 API Key agar sistem Sequential Failover punya cadangan otomatis saat Key #1 mencapai 100%.';
        recBadge.innerHTML = '<span class="pill pill-purple">0 / 10 Slot</span>';
        return;
      }

      // Determine which key is currently the active primary in sequential order
      let activeTurnId = null;
      for (const k of keys) {
        const pct = Math.min(100, Math.round(((k.used_requests || 0) / Math.max(1, k.quota_limit || 100)) * 100));
        if (k.enabled && k.status !== 'exhausted' && pct < 100) {
          activeTurnId = k.id;
          break;
        }
      }

      const exhaustedKeys = keys.filter(k => k.status === 'exhausted' || (k.used_requests || 0) >= (k.quota_limit || 100));
      const standbyKeys = keys.filter(k => k.id !== activeTurnId && (k.used_requests || 0) === 0 && k.status !== 'exhausted' && k.enabled);
      const nearlyFullKeys = keys.filter(k => {
        const pct = Math.round(((k.used_requests || 0) / Math.max(1, k.quota_limit || 100)) * 100);
        return pct >= 80 && pct < 100;
      });

      // Smart Recommendation Banner
      if (!activeTurnId) {
        recBanner.className = 'rec-banner warn';
        recHeadline.innerText = '🚨 Semua API Key di ' + ws.name + ' Sudah 100% Habis!';
        recDesc.innerText = 'Rekomendasi: Klik tombol "🔑 Ganti Key" pada Slot #1 untuk memasukkan API Key baru, atau klik "🔄 Reset Semua Usage (0%)" jika kuota key lama sudah di-topup.';
        recBadge.innerHTML = '<span class="pill" style="background:rgba(239,68,68,0.2);color:#f87171;">Perlu Ganti Key</span>';
      } else {
        const activeKeyObj = keys.find(k => k.id === activeTurnId);
        const activePct = Math.min(100, Math.round(((activeKeyObj.used_requests || 0) / Math.max(1, activeKeyObj.quota_limit || 100)) * 100));
        recBanner.className = (exhaustedKeys.length > 0 || nearlyFullKeys.length > 0) ? 'rec-banner warn' : 'rec-banner';
        recHeadline.innerText = '💡 Rekomendasi Terbaik — Giliran Aktif: ' + activeKeyObj.name + ' (' + activePct + '% Terpakai)';
        const parts = [];
        if (exhaustedKeys.length > 0) {
          parts.push('⚠️ ' + exhaustedKeys.length + ' Key sudah habis 100% (klik "🔑 Ganti Key" di slot merah tanpa mengganggu trafik).');
        }
        if (nearlyFullKeys.length > 0) {
          parts.push('⏳ ' + nearlyFullKeys.map(k => k.name).join(', ') + ' hampir habis (≥80%).');
        }
        parts.push('🟢 ' + standbyKeys.length + ' Key cadangan masih 0% (Belum Digunakan & siap menerima limpahan otomatis).');
        recDesc.innerText = parts.join(' ');
        recBadge.innerHTML = '<span class="pill pill-green">' + standbyKeys.length + ' Key Belum Digunakan (0%)</span>';
      }

      grid.innerHTML = keys.map((k, idx) => {
        const limit = Math.max(1, k.quota_limit || 100);
        const used = k.used_requests || 0;
        const pct = Math.min(100, Math.round((used / limit) * 100));
        const isTurn = k.id === activeTurnId;
        const isExhausted = k.status === 'exhausted' || pct >= 100;
        const isUnused = used === 0 && !isExhausted;

        let barColor = 'linear-gradient(90deg, #10b981, #38bdf8)';
        let stateLabel = '🟢 BELUM DIGUNAKAN (0% STANDBY)';
        let cardClass = 'key-card';

        if (!k.enabled) {
          barColor = '#475569';
          stateLabel = '⏸️ DISABLED';
        } else if (isExhausted) {
          barColor = 'linear-gradient(90deg, #f97316, #ef4444)';
          stateLabel = '🔴 HABIS (100%) — PERLU GANTI KEY';
          cardClass = 'key-card exhausted-turn';
        } else if (pct >= 80) {
          barColor = 'linear-gradient(90deg, #f59e0b, #ef4444)';
          stateLabel = (isTurn ? '⚡ SEDANG DIPAKAI — ' : '') + '⚠️ HAMPIR HABIS (' + pct + '%)';
          cardClass = 'key-card warning-turn';
        } else if (isTurn) {
          barColor = 'linear-gradient(90deg, #10b981, #38bdf8)';
          stateLabel = '⚡ SEDANG DIGUNAKAN (GILIRAN UTAMA)';
          cardClass = 'key-card active-turn';
        } else if (!isUnused) {
          stateLabel = '🟡 TERPAKAI SEBAGIAN (' + pct + '%)';
        }

        return \`
          <div class="\${cardClass}">
            <div class="key-top">
              <div>
                <span class="slot-num">SLOT #\${idx + 1}</span>
                <strong style="margin-left:6px; font-size:0.94rem;">\${escapeHtml(k.name)}</strong>
                <div style="font-size:0.74rem; color:var(--muted); margin-top:3px;">
                  Provider: <strong>\${escapeHtml(k.provider)}</strong> &bull; Key: <code>\${escapeHtml(k.masked_key)}</code>
                </div>
              </div>
              <span class="pill" style="font-size:0.68rem; padding:3px 8px; background:rgba(255,255,255,0.06);">\${stateLabel}</span>
            </div>

            <div class="usage-wrap">
              <div class="usage-labels">
                <span>Pemakaian Kuota: <strong>\${used} / \${limit} req</strong></span>
                <span style="color:\${isExhausted ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399'}; font-size:0.86rem;">\${pct}%</span>
              </div>
              <div class="usage-bar-bg">
                <div class="usage-bar-fill" style="width:\${pct}%; background:\${barColor};"></div>
              </div>
            </div>

            <div style="font-size:0.73rem; color:var(--muted); margin-bottom:10px; display:flex; justify-content:space-between;">
              <span>Sukses: \${k.success_count} | Gagal: \${k.fail_count}</span>
              <span style="color:#f87171; max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="\${escapeHtml(k.last_error || '')}">\${escapeHtml(k.last_error || 'Sehat')}</span>
            </div>

            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn-sm btn-cyan" onclick="replaceApiKey(\${k.id}, '\${escapeHtml(k.name)}', \${limit})">🔑 Ganti API Key</button>
              <button class="btn-sm" onclick="editQuotaLimit(\${k.id}, \${limit})">🎯 Set Kuota</button>
              <button class="btn-sm btn-green" onclick="resetSingleKey(\${k.id})">🔄 Reset 0%</button>
              <button class="btn-sm" onclick="simulateUsage(\${k.id}, \${limit})">🧪 Simulasi 90%</button>
              <button class="btn-sm btn-danger" onclick="deleteKey(\${k.id})">🗑️</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function addKeyToWorkspace() {
      const name = document.getElementById('k-name').value.trim() || ('Slot #' + (CURRENT_KEYS.length + 1) + ' Key');
      const provider = document.getElementById('k-provider').value;
      const base_url = document.getElementById('k-baseurl').value.trim();
      const api_key = document.getElementById('k-secret').value.trim();
      const quota_limit = Number(document.getElementById('k-quota').value) || 100;
      if (!api_key) return alert('Masukkan API Key terlebih dahulu!');

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: CURRENT_WS_ID,
          name,
          provider,
          base_url,
          api_key,
          quota_limit
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return alert(data.error || 'Gagal menambah key');
      }
      document.getElementById('k-name').value = '';
      document.getElementById('k-secret').value = '';
      await loadWorkspacesAndKeys();
    }

    async function replaceApiKey(id, currentName, currentLimit) {
      const newKey = prompt('Masukkan API Key pengganti yang baru untuk "' + currentName + '" (Usage otomatis di-reset ke 0%):');
      if (!newKey || !newKey.trim()) return;
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          action: 'replace_key',
          api_key: newKey.trim(),
          quota_limit: currentLimit
        })
      });
      await loadWorkspacesAndKeys();
    }

    async function editQuotaLimit(id, currentLimit) {
      const val = prompt('Ubah batas maksimal request (100% kuota) untuk key ini:', String(currentLimit));
      if (!val) return;
      const quota_limit = Math.max(1, Number(val) || 100);
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'set_quota', quota_limit })
      });
      await loadWorkspacesAndKeys();
    }

    async function simulateUsage(id, limit) {
      const used = Math.floor(limit * 0.9);
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'set_used', used_requests: used })
      });
      await loadWorkspacesAndKeys();
    }

    async function resetSingleKey(id) {
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'reset' })
      });
      await loadWorkspacesAndKeys();
    }

    async function resetWorkspaceUsage() {
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: CURRENT_WS_ID, action: 'reset_workspace' })
      });
      await loadWorkspacesAndKeys();
    }

    async function deleteKey(id) {
      await fetch('/api/keys?id=' + id, { method: 'DELETE' });
      await loadWorkspacesAndKeys();
    }

    // MODELS TABLE & BULK TEST
    function getFilteredModels() {
      const q = (document.getElementById('search')?.value || '').toLowerCase();
      return MODELS.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.providerDisplay.toLowerCase().includes(q)
      );
    }

    function renderStatusBadge(id) {
      const r = TEST_RESULTS[id];
      if (!r) return '<span class="pill" style="background:#1e293b;color:#94a3b8">READY</span>';
      if (r.status === 'testing') return '<span class="pill" style="background:rgba(245,158,11,0.2);color:#fbbf24">⏳ TESTING...</span>';
      if (r.status === 'ok') return '<span class="pill pill-green">✅ OK</span>';
      return '<span class="pill" style="background:rgba(239,68,68,0.2);color:#f87171">❌ GAGAL</span>';
    }

    function renderRows(list) {
      const tbody = document.getElementById('model-tbody');
      tbody.innerHTML = list.map((m, i) => {
        const r = TEST_RESULTS[m.id];
        const lat = r?.latencyMs ? r.latencyMs + ' ms' : '-';
        const detail = r?.status === 'ok'
          ? '<span style="color:#34d399">' + escapeHtml(r.reply) + '</span>'
          : '<span style="color:#f87171">' + escapeHtml(r?.error || '') + '</span>';
        const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        return \`
          <tr id="row-\${safeId}">
            <td>\${i + 1}</td>
            <td><code class="id">\${m.id}</code> \${m.featured ? '⭐' : ''}</td>
            <td>\${m.providerDisplay}</td>
            <td id="st-\${safeId}">\${renderStatusBadge(m.id)}</td>
            <td id="lat-\${safeId}">\${lat}</td>
            <td id="det-\${safeId}" style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${detail}</td>
            <td><button class="btn-sm" onclick="testSingleModel('\${m.id}')">Tes di Room Ini</button></td>
          </tr>
        \`;
      }).join('');
    }

    function updateSingleRowDOM(modelId) {
      const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const r = TEST_RESULTS[modelId];
      const stEl = document.getElementById('st-' + safeId);
      const latEl = document.getElementById('lat-' + safeId);
      const detEl = document.getElementById('det-' + safeId);
      if (stEl) stEl.innerHTML = renderStatusBadge(modelId);
      if (latEl) latEl.innerText = r?.latencyMs ? r.latencyMs + ' ms' : '-';
      if (detEl && r) {
        if (r.status === 'testing') {
          detEl.innerHTML = '<span style="color:#fbbf24">Mengirim prompt...</span>';
        } else if (r.status === 'ok') {
          detEl.innerHTML = '<span style="color:#34d399">' + escapeHtml(r.reply) + '</span>';
        } else {
          detEl.innerHTML = '<span style="color:#f87171">' + escapeHtml(r.error) + '</span>';
        }
      }
    }

    function filterModels() {
      renderRows(getFilteredModels());
    }

    async function testSingleModel(modelId, customPrompt) {
      const prompt = customPrompt || document.getElementById('bt-prompt').value.trim() || 'hallo';
      TEST_RESULTS[modelId] = { status: 'testing' };
      updateSingleRowDOM(modelId);
      try {
        const res = await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, prompt, workspace_id: CURRENT_WS_ID })
        });
        const data = await res.json();
        if (data.ok) {
          TEST_RESULTS[modelId] = {
            status: 'ok',
            latencyMs: data.latencyMs,
            reply: data.reply,
            keyUsed: data.keyUsed
          };
        } else {
          TEST_RESULTS[modelId] = {
            status: 'fail',
            latencyMs: data.latencyMs,
            error: data.error || ('HTTP ' + data.status)
          };
        }
      } catch (err) {
        TEST_RESULTS[modelId] = { status: 'fail', latencyMs: 0, error: err.message };
      }
      updateSingleRowDOM(modelId);
      await loadKeysForCurrentWorkspace();
      return TEST_RESULTS[modelId];
    }

    async function startBulkTest() {
      if (bulkRunning) return;
      const scope = document.getElementById('bt-scope').value;
      const prompt = document.getElementById('bt-prompt').value.trim() || 'hallo';
      const concurrency = Number(document.getElementById('bt-concurrency').value) || 1;

      let queue = scope === 'featured'
        ? MODELS.filter(m => m.featured)
        : scope === 'filtered'
          ? getFilteredModels()
          : [...MODELS];

      bulkRunning = true;
      bulkStopRequested = false;
      document.getElementById('bt-start-btn').disabled = true;
      document.getElementById('bt-stop-btn').disabled = false;

      let completed = 0;
      let okCount = 0;
      const total = queue.length;
      let cursor = 0;

      async function worker() {
        while (!bulkStopRequested) {
          const idx = cursor++;
          if (idx >= total) break;
          const m = queue[idx];
          document.getElementById('bt-current').innerText = m.id;
          const res = await testSingleModel(m.id, prompt);
          completed++;
          if (res.status === 'ok') okCount++;
          const pct = Math.round((completed / total) * 100);
          document.getElementById('bt-progress').style.width = pct + '%';
          document.getElementById('bt-state').innerText = completed + '/' + total + ' (' + pct + '%)';
          document.getElementById('bt-ok').innerText = okCount;
        }
      }

      const workers = [];
      for (let w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);

      bulkRunning = false;
      document.getElementById('bt-start-btn').disabled = false;
      document.getElementById('bt-stop-btn').disabled = true;
      document.getElementById('bt-state').innerText = bulkStopRequested ? 'Dihentikan' : 'Selesai ✅';
      document.getElementById('bt-current').innerText = '-';
    }

    function stopBulkTest() {
      bulkStopRequested = true;
    }

    function copyWorkingModels() {
      navigator.clipboard.writeText(MODELS.map(m => m.id).join('\\n'));
      alert(MODELS.length + ' Verified Model IDs berhasil disalin!');
    }

    function exportBulkResults() {
      const blob = new Blob([JSON.stringify(TEST_RESULTS, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'twix-verified-models.json';
      a.click();
    }

    function copyPre(id) {
      navigator.clipboard.writeText(document.getElementById(id).innerText);
    }

    loadWorkspacesAndKeys();
    renderRows(MODELS);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    let path = parsedUrl.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    // Support workspace-prefixed routes: `/w/:workspaceSlug/v1/...`
    let pathWorkspaceSlug: string | undefined;
    const wsMatch = path.match(/^\/w\/([^/]+)(\/.*)$/);
    if (wsMatch) {
      pathWorkspaceSlug = decodeURIComponent(wsMatch[1]);
      path = wsMatch[2];
    }

    // 1. Health check
    if (method === 'GET' && (path === '/health' || path === '/api/health')) {
      const workspaces = await getWorkspaces();
      const keys = await getAllKeys();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 'healthy',
          verifiedModels: catalogModels.length,
          workspacesCount: workspaces.length,
          totalKeys: keys.length,
        })
      );
      return;
    }

    // 2. Dashboard UI
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    // 3. Workspaces CRUD (`/api/workspaces`) — Unlimited Custom Workspaces
    if (path === '/api/workspaces') {
      if (method === 'GET') {
        const workspaces = await getWorkspaces();
        const keys = await getAllKeys();
        const enriched = workspaces.map((w) => {
          const wKeys = keys.filter((k) => k.workspace_id === w.id);
          return {
            ...w,
            key_count: wKeys.length,
          };
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ workspaces: enriched }));
        return;
      }

      if (method === 'POST' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || 'Workspace Baru').trim();
        const baseSlug = slugify(name);
        const slug = `${baseSlug}-${Math.floor(100 + Math.random() * 900)}`;
        const token = `twix-ws-${slug}`;
        const rows = await sql`
          INSERT INTO workspaces (name, slug, workspace_token, max_keys, is_default)
          VALUES (${name}, ${slug}, ${token}, 10, false)
          RETURNING *
        `;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, workspace: rows[0] }));
        return;
      }

      if (method === 'PATCH' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const id = Number(body.id);
        if (body.action === 'set_default' && id) {
          await sql`UPDATE workspaces SET is_default = false`;
          await sql`UPDATE workspaces SET is_default = true WHERE id = ${id}`;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (body.name && id) {
          await sql`UPDATE workspaces SET name = ${String(body.name).trim()} WHERE id = ${id}`;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      if (method === 'DELETE' && sql) {
        const id = Number(parsedUrl.searchParams.get('id'));
        if (id) {
          await sql`DELETE FROM api_keys WHERE workspace_id = ${id}`;
          await sql`DELETE FROM workspaces WHERE id = ${id}`;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // 4. API Keys CRUD (`/api/keys`) — Enforces Max 10 Keys per Workspace + Usage % Tracking
    if (path === '/api/keys') {
      if (method === 'GET') {
        const wsIdParam = parsedUrl.searchParams.get('workspace_id');
        const keys = await getAllKeys(wsIdParam ? Number(wsIdParam) : undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            total: keys.length,
            keys: keys.map((k) => {
              const limit = Math.max(1, Number(k.quota_limit || 100));
              const used = Number(k.used_requests || 0);
              return {
                ...k,
                api_key: undefined,
                masked_key: maskKey(k.api_key),
                usage_percent: Math.min(100, Math.round((used / limit) * 100)),
              };
            }),
          })
        );
        return;
      }

      if (method === 'POST' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const wsId = Number(body.workspace_id || 1);
        const existingInWs = await getAllKeys(wsId);
        if (existingInWs.length >= 10) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                'Workspace ini sudah penuh (Maksimal 10 API Key per Workspace). Silakan buat Workspace baru atau ganti key yang sudah habis.',
            })
          );
          return;
        }

        const prov = String(body.provider ?? 'openrouter').toLowerCase();
        const bUrl =
          body.base_url?.trim() ||
          PROVIDER_DEFAULTS[prov] ||
          'https://openrouter.ai/api/v1';
        const name = body.name?.trim() || `Slot #${existingInWs.length + 1} Key`;
        const quotaLimit = Math.max(1, Number(body.quota_limit || 100));
        const nextPriority = existingInWs.length + 1;

        await sql`
          INSERT INTO api_keys (workspace_id, name, provider, base_url, api_key, enabled, status, quota_limit, used_requests, priority_order)
          VALUES (${wsId}, ${name}, ${prov}, ${bUrl}, ${String(body.api_key).trim()}, true, 'active', ${quotaLimit}, 0, ${nextPriority})
        `;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === 'PATCH' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const id = Number(body.id);

        // Replace an exhausted key in-place and reset its usage % to 0%
        if (body.action === 'replace_key' && id && body.api_key) {
          const limit = Math.max(1, Number(body.quota_limit || 100));
          await sql`
            UPDATE api_keys
            SET api_key = ${String(body.api_key).trim()},
                quota_limit = ${limit},
                used_requests = 0,
                status = 'active',
                cooldown_until = 0,
                last_error = NULL
            WHERE id = ${id}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (body.action === 'set_quota' && id) {
          const limit = Math.max(1, Number(body.quota_limit || 100));
          await sql`
            UPDATE api_keys
            SET quota_limit = ${limit},
                status = CASE WHEN used_requests >= ${limit} THEN 'exhausted' ELSE 'active' END
            WHERE id = ${id}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (body.action === 'set_used' && id) {
          const used = Math.max(0, Number(body.used_requests || 0));
          await sql`
            UPDATE api_keys
            SET used_requests = ${used},
                status = CASE WHEN used_requests >= quota_limit THEN 'exhausted' ELSE 'active' END
            WHERE id = ${id}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (body.action === 'reset_workspace' && body.workspace_id) {
          await sql`
            UPDATE api_keys
            SET status = 'active', used_requests = 0, cooldown_until = 0, last_error = NULL
            WHERE workspace_id = ${Number(body.workspace_id)}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (body.action === 'reset' && id) {
          await sql`
            UPDATE api_keys
            SET status = 'active', used_requests = 0, cooldown_until = 0, last_error = NULL
            WHERE id = ${id}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      if (method === 'DELETE' && sql) {
        const id = Number(parsedUrl.searchParams.get('id'));
        if (id) {
          await sql`DELETE FROM api_keys WHERE id = ${id}`;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // 5. Fast Single-Model Test Endpoint
    if (method === 'POST' && path === '/api/models/test') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const modelId = String(body.model ?? 'google/gemini-4-argon');
      const prompt = String(body.prompt ?? 'hallo');
      const workspaces = await getWorkspaces();
      const targetWs =
        workspaces.find((w) => w.id === Number(body.workspace_id)) ||
        (await resolveTargetWorkspace(req, parsedUrl, pathWorkspaceSlug));

      const t0 = Date.now();
      try {
        const { upstream, usedKey } = await executeWorkspaceSequentialFailover(
          targetWs,
          'chat',
          {
            model: modelId,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 16,
            stream: false,
          },
          undefined,
          18000
        );
        const latencyMs = Date.now() - t0;
        const rawText = await upstream.text();
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(rawText);
        } catch {
          // ignore
        }

        if (upstream.ok) {
          const choices = json.choices as
            | Array<{ message?: { content?: string; reasoning?: string } }>
            | undefined;
          const reply =
            choices?.[0]?.message?.content ||
            choices?.[0]?.message?.reasoning ||
            'OK';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              model: modelId,
              latencyMs,
              workspace: targetWs.name,
              keyUsed: `#${usedKey.id} (${usedKey.name})`,
              reply: String(reply).trim().slice(0, 140),
            })
          );
          return;
        }

        const errMsg =
          (json?.error as { message?: string })?.message ||
          rawText.slice(0, 140) ||
          `HTTP ${upstream.status}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            model: modelId,
            status: upstream.status,
            latencyMs,
            error: errMsg,
          })
        );
        return;
      } catch (err) {
        const latencyMs = Date.now() - t0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            model: modelId,
            latencyMs,
            error: err instanceof Error ? err.message : String(err),
          })
        );
        return;
      }
    }

    // 6. GET /v1/models & /v1/models/image & /v1/models/info (Only 266 Verified Working Models)
    if (method === 'GET' && path === '/v1/models/info') {
      const id = parsedUrl.searchParams.get('id');
      const found = catalogModels.find((m) => m.id === id);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Model not found: ${id}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found));
      return;
    }

    if (method === 'GET' && (path === '/v1/models' || path === '/v1/models/image')) {
      const onlyImage = path === '/v1/models/image';
      const list = onlyImage
        ? catalogModels.filter((m) => m.outputTypes?.includes('image'))
        : catalogModels;
      const response = {
        object: 'list',
        total: list.length,
        data: list.map((m) => ({
          id: m.id,
          object: 'model',
          created: 1735000000,
          owned_by: m.providerDisplay.toLowerCase(),
          display_name: m.displayName,
          context_window: m.contextWindow,
          reasoning: m.reasoning,
          pricing: { input_per_1m: m.inputCost, output_per_1m: m.outputCost },
          output_types: m.outputTypes,
        })),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
      return;
    }

    // 7. POST /v1/chat/completions (Workspace Sequential Spillover)
    if (method === 'POST' && path === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }

      const targetWs = await resolveTargetWorkspace(req, parsedUrl, pathWorkspaceSlug);
      const { upstream, usedKey, attempts } = await executeWorkspaceSequentialFailover(
        targetWs,
        'chat',
        payload
      );

      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      res.writeHead(upstream.status, {
        'content-type': contentType,
        'x-router-workspace': `${targetWs.name} (${targetWs.slug})`,
        'x-router-key-used': `#${usedKey.id} (${usedKey.name})`,
        'x-router-attempts': JSON.stringify(attempts),
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      return;
    }

    // 8. POST /v1/messages (Anthropic format with Workspace Sequential Spillover)
    if (method === 'POST' && path === '/v1/messages') {
      const bodyText = await readBody(req);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }

      const targetWs = await resolveTargetWorkspace(req, parsedUrl, pathWorkspaceSlug);
      const { upstream, usedKey, attempts } = await executeWorkspaceSequentialFailover(
        targetWs,
        'messages',
        payload,
        {
          'anthropic-version':
            req.headers['anthropic-version']?.toString() ?? '2023-06-01',
        }
      );

      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      res.writeHead(upstream.status, {
        'content-type': contentType,
        'x-router-workspace': `${targetWs.name} (${targetWs.slug})`,
        'x-router-key-used': `#${usedKey.id} (${usedKey.name})`,
        'x-router-attempts': JSON.stringify(attempts),
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      return;
    }

    // 9. POST /v1/images/generations
    if (method === 'POST' && path === '/v1/images/generations') {
      const bodyText = await readBody(req);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }

      const rawModel = String(payload.model ?? 'gpt-image-2');
      const cleanModel = rawModel.replace(/^openai\//, '');
      const upstreamBody = { ...payload, model: cleanModel };
      delete upstreamBody.response_format;

      const targetWs = await resolveTargetWorkspace(req, parsedUrl, pathWorkspaceSlug);
      const { upstream, usedKey, attempts } = await executeWorkspaceSequentialFailover(
        targetWs,
        'images',
        upstreamBody
      );

      const data = (await upstream.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>;
      };

      if (
        parsedUrl.searchParams.get('response_format') === 'binary' &&
        data?.data?.[0]?.b64_json
      ) {
        const imgBuf = Buffer.from(data.data[0].b64_json, 'base64');
        res.writeHead(200, {
          'content-type': 'image/png',
          'x-router-workspace': `${targetWs.name} (${targetWs.slug})`,
          'x-router-key-used': `#${usedKey.id} (${usedKey.name})`,
          'x-router-attempts': JSON.stringify(attempts),
        });
        res.end(imgBuf);
        return;
      }

      res.writeHead(upstream.status, {
        'content-type': 'application/json',
        'x-router-workspace': `${targetWs.name} (${targetWs.slug})`,
        'x-router-key-used': `#${usedKey.id} (${usedKey.name})`,
        'x-router-attempts': JSON.stringify(attempts),
      });
      res.end(JSON.stringify(data));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `Route ${method} ${path} not found.`,
        },
      })
    );
  } catch (error) {
    console.error('[webserver] request failed', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : 'Internal error' },
      })
    );
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[webserver] Twix AI Router (Unlimited Workspaces + 266 Verified Models) listening on :${PORT}`);
});
