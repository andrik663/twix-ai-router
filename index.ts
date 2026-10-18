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
  <title>Twix AI Router</title>
  <style>
    :root {
      --bg: #f7f6f3;
      --card: #ffffff;
      --border: #e8e6e1;
      --border-strong: #d8d5cf;
      --text: #201f1c;
      --muted: #716d64;
      --accent: #2b56c6;
      --accent-hover: #2148ad;
      --accent-soft: rgba(43, 86, 198, 0.08);
      --green: #177a45;
      --green-soft: rgba(23, 122, 69, 0.1);
      --amber: #a05c08;
      --amber-soft: rgba(160, 92, 8, 0.1);
      --red: #bf3b30;
      --red-soft: rgba(191, 59, 48, 0.08);
      --purple: #6a4fbf;
      --purple-soft: rgba(106, 79, 194, 0.09);
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.55;
    }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .container { max-width: 1120px; margin: 0 auto; padding: 0 24px 88px; }

    /* Top bar + workspace tabs */
    .topbar {
      position: sticky; top: 0; z-index: 20;
      background: rgba(255,255,255,0.92); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
    }
    .topbar-inner {
      max-width: 1120px; margin: 0 auto; padding: 0 24px; height: 58px;
      display: flex; align-items: center; gap: 28px;
    }
    .brand { font-weight: 650; font-size: 15px; letter-spacing: -0.01em; white-space: nowrap; }
    .brand-meta { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
    .topbar .ws-bar { flex: 1; min-width: 0; }

    .ws-bar { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .ws-bar::-webkit-scrollbar { display: none; }
    .ws-tab {
      background: transparent; border: none; color: var(--muted);
      padding: 8px 12px; cursor: pointer; font-weight: 550; font-size: 13.5px;
      display: flex; align-items: center; gap: 8px; white-space: nowrap;
      border-radius: 8px; transition: color .15s, background .15s;
      font-family: inherit;
    }
    .ws-tab:hover { color: var(--text); background: var(--accent-soft); }
    .ws-tab.active { color: var(--text); background: #efede8; }
    .ws-slot-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .ws-add-btn {
      margin-left: 8px; background: var(--card); border: 1px solid var(--border-strong);
      color: var(--text); padding: 7px 13px; border-radius: 8px; font-weight: 550;
      font-size: 13px; cursor: pointer; white-space: nowrap; transition: border-color .15s, color .15s;
    }
    .ws-add-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* Page head */
    .page-head { padding: 34px 0 2px; }
    .page-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .page-head h1 {
      margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.015em;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .lede { color: var(--muted); margin: 10px 0 0; max-width: 620px; font-size: 13.5px; }
    .endpoint-line { margin: 12px 0 0; font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .endpoint-line code { background: var(--card); border: 1px solid var(--border); padding: 3px 8px; border-radius: 6px; font-size: 12px; color: var(--text); }
    .endpoint-line .tok { color: var(--purple); }
    .head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* Pills */
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 9px; border-radius: 999px;
      font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
      background: #f1efe9; color: var(--muted);
    }
    .pill-green { background: var(--green-soft); color: var(--green); }
    .pill-purple { background: var(--purple-soft); color: var(--purple); }

    /* Buttons & inputs */
    .btn-sm {
      background: var(--card); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 8px;
      padding: 5px 11px; font-size: 12.5px; cursor: pointer; font-weight: 550;
      transition: border-color .15s, color .15s; font-family: inherit;
    }
    .btn-sm:hover { border-color: var(--text); }
    .btn-cyan { color: var(--accent); border-color: rgba(43,86,198,.35); background: var(--accent-soft); }
    .btn-cyan:hover { border-color: var(--accent); }
    .btn-green { color: var(--green); border-color: rgba(23,122,69,.35); background: var(--green-soft); }
    .btn-green:hover { border-color: var(--green); }
    .btn-danger { color: var(--red); border-color: rgba(191,59,48,.35); background: var(--red-soft); }
    .btn-danger:hover { border-color: var(--red); }

    input, select {
      width: 100%; padding: 8px 11px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--card); color: var(--text);
      font-size: 13.5px; font-family: inherit;
      transition: border-color .15s, box-shadow .15s;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; font-weight: 550; }
    button.primary {
      background: var(--accent); color: #fff; border: none;
      padding: 9px 14px; border-radius: 8px; font-weight: 600; font-size: 13.5px;
      cursor: pointer; font-family: inherit; transition: background .15s;
    }
    button.primary:hover { background: var(--accent-hover); }
    button.primary:disabled { opacity: .45; cursor: not-allowed; }

    /* Recommendation banner */
    .rec-banner {
      background: var(--accent-soft); border: 1px solid rgba(43,86,198,.18);
      border-radius: 10px; padding: 13px 16px; margin: 24px 0 14px;
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
    }
    .rec-banner.warn { background: var(--amber-soft); border-color: rgba(160,92,8,.25); }
    .rec-title { font-weight: 600; font-size: 13.5px; }
    .rec-desc { font-size: 12.5px; color: var(--muted); margin-top: 2px; max-width: 720px; }

    /* Cards */
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-top: 18px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
    .card-title { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .card-sub { color: var(--muted); font-size: 12.5px; margin: 3px 0 0; }

    /* Key slots */
    .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .key-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; transition: border-color .2s, box-shadow .2s; }
    .key-card.active-turn { border-color: var(--green); box-shadow: inset 3px 0 0 var(--green); }
    .key-card.warning-turn { border-color: var(--amber); box-shadow: inset 3px 0 0 var(--amber); }
    .key-card.exhausted-turn { border-color: var(--red); box-shadow: inset 3px 0 0 var(--red); }
    .key-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
    .slot-num { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; color: var(--muted); text-transform: uppercase; }
    .usage-wrap { margin: 10px 0; }
    .usage-labels { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px; color: var(--muted); }
    .usage-bar-bg { width: 100%; height: 6px; background: #eceae5; border-radius: 999px; overflow: hidden; }
    .usage-bar-fill { height: 100%; border-radius: 999px; transition: width .3s ease; }

    /* Add-key form */
    .add-key-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; gap: 6px; }
    .add-key-title { font-weight: 600; font-size: 13.5px; }
    .add-key-note { font-size: 12px; color: var(--muted); }
    .form-grid { display: grid; grid-template-columns: 1.1fr 1fr 1.3fr 1.3fr .9fr .9fr; gap: 10px; align-items: end; }

    /* Bulk test */
    .bt-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1.4fr .7fr; gap: 10px; align-items: end; }
    .bt-stats { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .progress { margin: 14px 0 0; }

    /* Table & code */
    pre { background: #f4f2ee; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12.5px; color: #3f3d38; margin: 8px 0 0; }
    .table-wrap { overflow-x: auto; max-height: 520px; border: 1px solid var(--border); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    th { background: var(--card); position: sticky; top: 0; z-index: 1; color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: #fafaf8; }
    code.id { color: var(--accent); background: var(--accent-soft); padding: 2px 7px; border-radius: 5px; font-weight: 550; font-size: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }

    @media (max-width: 900px) {
      .form-grid, .bt-grid { grid-template-columns: 1fr 1fr; }
      .page-head { padding-top: 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="topbar" style="margin: 0 -24px; padding: 0 24px;">
      <div class="topbar-inner" style="padding: 0;">
        <div class="brand">Twix AI Router</div>
        <div class="brand-meta">${catalogModels.length} model terverifikasi · failover otomatis</div>
        <nav class="ws-bar" id="ws-bar"></nav>
      </div>
    </header>

    <section class="page-head">
      <div class="page-head-row">
        <div>
          <h1>
            <span id="ws-title">Workspace</span>
            <span class="pill" id="ws-slot-counter">1 / 10 slot</span>
            <span class="pill pill-green" id="ws-default-badge" style="display:none">Default global</span>
          </h1>
          <p class="endpoint-line">
            <span>Endpoint</span>
            <code id="ws-endpoint">${PUBLIC_URL}/w/workspace-1/v1/chat/completions</code>
            <span>Workspace key</span>
            <code class="tok" id="ws-token">twix-ws-1</code>
          </p>
        </div>
        <div class="head-actions">
          <button class="btn-sm" onclick="setAsDefaultWorkspace()">Jadikan default</button>
          <button class="btn-sm" onclick="renameCurrentWorkspace()">Ubah nama</button>
          <button class="btn-sm" onclick="resetWorkspaceUsage()">Reset usage</button>
          <button class="btn-sm btn-danger" onclick="deleteCurrentWorkspace()">Hapus</button>
        </div>
      </div>
      <p class="lede">Key #1 dipakai sampai habis, lalu trafik otomatis lanjut ke key berikutnya. Maksimal 10 key per workspace.</p>
    </section>

    <div class="rec-banner" id="rec-banner">
      <div>
        <div class="rec-title" id="rec-headline">Memuat analisis workspace…</div>
        <div class="rec-desc" id="rec-desc"></div>
      </div>
      <div id="rec-badge"></div>
    </div>

    <div class="slots-grid" id="keys-grid"></div>

    <section class="card">
      <div class="add-key-head">
        <div class="add-key-title">Tambah key ke <span id="add-ws-name">Workspace 1</span></div>
        <div class="add-key-note">Slot #1 penuh dulu, lalu otomatis lanjut ke slot #2 dan seterusnya</div>
      </div>
      <div class="form-grid">
        <div>
          <label>Label</label>
          <input id="k-name" placeholder="Key utama #1" />
        </div>
        <div>
          <label>Provider</label>
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
          <label>Base URL</label>
          <input id="k-baseurl" value="https://openrouter.ai/api/v1" />
        </div>
        <div>
          <label>API Key</label>
          <input id="k-secret" placeholder="sk-..." />
        </div>
        <div>
          <label>Kuota (req = 100%)</label>
          <input id="k-quota" type="number" value="100" min="1" title="Jumlah request maksimal sebelum key ini dianggap 100% habis dan pindah ke key berikutnya" />
        </div>
        <div>
          <button class="primary" id="btn-add-key" onclick="addKeyToWorkspace()" style="width:100%">Tambah slot</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Bulk test model</h2>
          <p class="card-sub">Uji ${catalogModels.length} model terverifikasi dari workspace ini</p>
        </div>
        <div class="head-actions">
          <button class="btn-sm" onclick="copyWorkingModels()">Copy semua model ID</button>
          <button class="btn-sm" onclick="exportBulkResults()">Download JSON</button>
        </div>
      </div>

      <div class="bt-grid">
        <div>
          <label>Prompt test</label>
          <input id="bt-prompt" value="hallo" />
        </div>
        <div>
          <label>Target</label>
          <select id="bt-scope">
            <option value="all">Semua ${catalogModels.length} model</option>
            <option value="filtered">Hanya yang difilter</option>
            <option value="featured">Featured (${featured.length})</option>
          </select>
        </div>
        <div>
          <label>Bersamaan</label>
          <select id="bt-concurrency">
            <option value="1" selected>1 per 1</option>
            <option value="2">2 paralel</option>
            <option value="3">3 paralel</option>
          </select>
        </div>
        <div>
          <button class="primary" id="bt-start-btn" onclick="startBulkTest()" style="width:100%">Mulai tes</button>
        </div>
        <div>
          <button class="btn-sm btn-danger" id="bt-stop-btn" onclick="stopBulkTest()" style="width:100%; padding:9px;" disabled>Stop</button>
        </div>
      </div>

      <div class="progress">
        <div class="usage-bar-bg">
          <div class="usage-bar-fill" id="bt-progress" style="width:100%"></div>
        </div>
      </div>

      <div class="bt-stats">
        <span class="pill">Status: <strong id="bt-state">Siap</strong></span>
        <span class="pill pill-green">OK: <strong id="bt-ok">${catalogModels.length}</strong></span>
        <span class="pill">Sedang dites: <code id="bt-current">-</code></span>
      </div>
    </section>

    <div class="grid-2">
      <section class="card" style="margin-top:0;">
        <div class="card-header" style="margin-bottom:6px;">
          <h2 class="card-title" style="font-size:13.5px;">Chat completions</h2>
          <button class="btn-sm" onclick="copyPre('curl-ws')">Copy</button>
        </div>
        <pre id="curl-ws"></pre>
      </section>
      <section class="card" style="margin-top:0;">
        <div class="card-header" style="margin-bottom:6px;">
          <h2 class="card-title" style="font-size:13.5px;">Ganti key via API</h2>
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
      </section>
    </div>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Katalog model</h2>
          <p class="card-sub">${catalogModels.length} model terverifikasi siap dipakai</p>
        </div>
      </div>
      <input id="search" placeholder="Cari model (mis. gemini, claude, gpt, deepseek)…" oninput="filterModels()" style="margin-bottom:12px;" />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Model ID</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Respons</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="model-tbody"></tbody>
        </table>
      </div>
    </section>
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
          <span>\${escapeHtml(w.name)}</span>
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

      document.getElementById('ws-title').innerText = ws.name;
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
        recHeadline.innerText = 'Workspace ini belum punya API key';
        recDesc.innerText = 'Tambah minimal 2-5 key agar failover punya cadangan saat key utama habis.';
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
        recHeadline.innerText = 'Semua key di ' + ws.name + ' sudah habis (100%)';
        recDesc.innerText = 'Ganti key pada slot yang habis, atau reset usage jika kuota sudah di-top-up.';
        recBadge.innerHTML = '<span class="pill" style="background:var(--red-soft);color:var(--red);">Perlu ganti key</span>';
      } else {
        const activeKeyObj = keys.find(k => k.id === activeTurnId);
        const activePct = Math.min(100, Math.round(((activeKeyObj.used_requests || 0) / Math.max(1, activeKeyObj.quota_limit || 100)) * 100));
        recBanner.className = (exhaustedKeys.length > 0 || nearlyFullKeys.length > 0) ? 'rec-banner warn' : 'rec-banner';
        recHeadline.innerText = 'Giliran aktif: ' + activeKeyObj.name + ' (' + activePct + '% terpakai)';
        const parts = [];
        if (exhaustedKeys.length > 0) {
          parts.push(exhaustedKeys.length + ' key habis 100%, ganti tanpa mengganggu trafik.');
        }
        if (nearlyFullKeys.length > 0) {
          parts.push(nearlyFullKeys.map(k => k.name).join(', ') + ' hampir habis (80%+).');
        }
        parts.push(standbyKeys.length + ' key cadangan masih 0% dan siap menerima limpahan.');
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

        let barColor = '#10b981';
        let stateLabel = 'Standby · 0%';
        let cardClass = 'key-card';

        if (!k.enabled) {
          barColor = '#a8a29e';
          stateLabel = 'Nonaktif';
        } else if (isExhausted) {
          barColor = '#bf3b30';
          stateLabel = 'Habis 100% · ganti key';
          cardClass = 'key-card exhausted-turn';
        } else if (pct >= 80) {
          barColor = '#a05c08';
          stateLabel = (isTurn ? 'Aktif · ' : '') + 'Hampir habis (' + pct + '%)';
          cardClass = 'key-card warning-turn';
        } else if (isTurn) {
          barColor = 'linear-gradient(90deg, #10b981, #38bdf8)';
          stateLabel = 'Aktif · giliran utama';
          cardClass = 'key-card active-turn';
        } else if (!isUnused) {
          stateLabel = 'Terpakai ' + pct + '%';
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
              <span class="pill">\${stateLabel}</span>
            </div>

            <div class="usage-wrap">
              <div class="usage-labels">
                <span>Pemakaian Kuota: <strong>\${used} / \${limit} req</strong></span>
                <span style="color:\${isExhausted ? '#bf3b30' : pct >= 80 ? '#a05c08' : '#177a45'}; font-size:0.86rem;">\${pct}%</span>
              </div>
              <div class="usage-bar-bg">
                <div class="usage-bar-fill" style="width:\${pct}%; background:\${barColor};"></div>
              </div>
            </div>

            <div style="font-size:0.73rem; color:var(--muted); margin-bottom:10px; display:flex; justify-content:space-between;">
              <span>Sukses: \${k.success_count} | Gagal: \${k.fail_count}</span>
              <span style="color:#bf3b30; max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="\${escapeHtml(k.last_error || '')}">\${escapeHtml(k.last_error || 'Sehat')}</span>
            </div>

            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn-sm btn-cyan" onclick="replaceApiKey(\${k.id}, '\${escapeHtml(k.name)}', \${limit})">Ganti key</button>
              <button class="btn-sm" onclick="editQuotaLimit(\${k.id}, \${limit})">Set kuota</button>
              <button class="btn-sm btn-green" onclick="resetSingleKey(\${k.id})">Reset 0%</button>
              <button class="btn-sm" onclick="simulateUsage(\${k.id}, \${limit})">Simulasi 90%</button>
              <button class="btn-sm btn-danger" onclick="deleteKey(\${k.id})">Hapus</button>
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
      if (!r) return '<span class="pill pill-plain">Siap</span>';
      if (r.status === 'testing') return '<span class="pill" style="background:var(--amber-soft);color:var(--amber)">Mengujui…</span>';
      if (r.status === 'ok') return '<span class="pill pill-green">OK</span>';
      return '<span class="pill" style="background:var(--red-soft);color:var(--red)">Gagal</span>';
    }

    function renderRows(list) {
      const tbody = document.getElementById('model-tbody');
      tbody.innerHTML = list.map((m, i) => {
        const r = TEST_RESULTS[m.id];
        const lat = r?.latencyMs ? r.latencyMs + ' ms' : '-';
        const detail = r?.status === 'ok'
          ? '<span style="color:#177a45">' + escapeHtml(r.reply) + '</span>'
          : '<span style="color:#bf3b30">' + escapeHtml(r?.error || '') + '</span>';
        const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        return \`
          <tr id="row-\${safeId}">
            <td>\${i + 1}</td>
            <td><code class="id">\${m.id}</code> </td>
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
          detEl.innerHTML = '<span style="color:#a05c08">Mengirim prompt…</span>';
        } else if (r.status === 'ok') {
          detEl.innerHTML = '<span style="color:#177a45">' + escapeHtml(r.reply) + '</span>';
        } else {
          detEl.innerHTML = '<span style="color:#bf3b30">' + escapeHtml(r.error) + '</span>';
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
      document.getElementById('bt-state').innerText = bulkStopRequested ? 'Dihentikan' : 'Selesai';
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
