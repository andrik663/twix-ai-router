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
};

type ApiKeyRow = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
  status: string;
  cooldown_until: number;
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

// Round-Robin pointer in memory, backed by Postgres pool
let rrIndex = 0;

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
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'openrouter',
      base_url TEXT NOT NULL DEFAULT 'https://openrouter.ai/api/v1',
      api_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      status TEXT NOT NULL DEFAULT 'active',
      cooldown_until BIGINT NOT NULL DEFAULT 0,
      total_requests BIGINT NOT NULL DEFAULT 0,
      success_count BIGINT NOT NULL DEFAULT 0,
      fail_count BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  const existing = await sql`SELECT COUNT(*)::int AS count FROM api_keys`;
  if (existing[0]?.count === 0) {
    await sql`
      INSERT INTO api_keys (name, provider, base_url, api_key, enabled, status)
      VALUES ('Skydive Built-in Sentinel (Fallback/Default)', 'openrouter', 'https://openrouter.ai/api/v1', 'sentinel', true, 'active')
    `;
  }
}

initDb().catch((err) => console.error('[webserver] DB init error:', err));

function maskKey(k: string): string {
  if (!k) return '';
  if (k === 'sentinel') return 'sentinel (Built-in)';
  if (k.length <= 10) return `${k.slice(0, 3)}***${k.slice(-2)}`;
  return `${k.slice(0, 6)}...${k.slice(-4)}`;
}

async function getAllKeys(): Promise<ApiKeyRow[]> {
  if (!sql) {
    return [
      {
        id: 1,
        name: 'Skydive Built-in Sentinel',
        provider: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sentinel',
        enabled: true,
        status: 'active',
        cooldown_until: 0,
        total_requests: 0,
        success_count: 0,
        fail_count: 0,
        last_error: null,
        last_used_at: null,
      },
    ];
  }
  const rows = await sql`
    SELECT id, name, provider, base_url, api_key, enabled, status,
           cooldown_until::bigint AS cooldown_until,
           total_requests::int AS total_requests,
           success_count::int AS success_count,
           fail_count::int AS fail_count,
           last_error, last_used_at
    FROM api_keys
    ORDER BY id ASC
  `;
  return rows as unknown as ApiKeyRow[];
}

async function getRoundRobinCandidates(): Promise<ApiKeyRow[]> {
  const all = await getAllKeys();
  const now = Date.now();
  const enabledKeys = all.filter((k) => k.enabled);
  if (enabledKeys.length === 0) return [];

  const ready = enabledKeys.filter(
    (k) => k.status !== 'exhausted' && Number(k.cooldown_until || 0) <= now
  );

  const pool = ready.length > 0 ? ready : enabledKeys;
  const start = rrIndex % pool.length;
  rrIndex = (rrIndex + 1) % Math.max(1, pool.length);

  const ordered: ApiKeyRow[] = [];
  for (let i = 0; i < pool.length; i++) {
    ordered.push(pool[(start + i) % pool.length]);
  }
  return ordered;
}

async function recordKeySuccess(id: number) {
  if (!sql) return;
  await sql`
    UPDATE api_keys
    SET status = 'active',
        cooldown_until = 0,
        total_requests = total_requests + 1,
        success_count = success_count + 1,
        last_used_at = NOW(),
        last_error = NULL
    WHERE id = ${id}
  `;
}

async function recordKeyFailure(id: number, statusCode: number, errText: string) {
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
  const cooldownUntil = isQuotaOrInvalid
    ? Date.now() + 3600_000
    : isRateLimit
      ? Date.now() + 60_000
      : 0;

  const shortErr = `HTTP ${statusCode}: ${errText.slice(0, 180)}`;
  await sql`
    UPDATE api_keys
    SET status = ${newStatus},
        cooldown_until = ${cooldownUntil},
        total_requests = total_requests + 1,
        fail_count = fail_count + 1,
        last_used_at = NOW(),
        last_error = ${shortErr}
    WHERE id = ${id}
  `;
}

function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, anthropic-version, x-goog-api-key'
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

async function executeWithRoundRobinFailover(
  endpointType: 'chat' | 'messages' | 'images',
  payloadObj: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  timeoutMs = 30000
): Promise<{
  upstream: Response;
  usedKey: ApiKeyRow;
  attempts: Array<{ keyId: number; keyName: string; status: number | string }>;
}> {
  const candidates = await getRoundRobinCandidates();
  if (candidates.length === 0) {
    throw new Error('Tidak ada API Key yang aktif di pool. Tambahkan minimal 1 API Key di Dashboard.');
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
        await recordKeySuccess(keyRow.id);
        attempts.push({ keyId: keyRow.id, keyName: keyRow.name, status: resp.status });
        return { upstream: resp, usedKey: keyRow, attempts };
      }

      const errText = await resp.text();
      // Only mark key failure if it's an auth/quota/rate-limit error (not 400/404 invalid model)
      if (resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429) {
        await recordKeyFailure(keyRow.id, resp.status, errText);
      }
      attempts.push({ keyId: keyRow.id, keyName: keyRow.name, status: resp.status });

      lastResponse = new Response(errText, {
        status: resp.status,
        headers: { 'content-type': resp.headers.get('content-type') ?? 'application/json' },
      });

      // If 400 or 404 (model doesn't exist on upstream), no need to burn other keys of the same provider
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
  throw new Error(`Semua ${candidates.length} API Key gagal dihubungi.`);
}

function renderDashboardHtml(): string {
  const featured = catalogModels.filter((m) => m.featured);
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Twix AI Router — Multi-Key Round-Robin &amp; Bulk Test 391 Models</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #131b2e;
      --border: #23304d;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent2: #818cf8;
      --green: #34d399;
      --yellow: #fbbf24;
      --red: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px 16px 60px;
    }
    .container { max-width: 1180px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { margin: 0; font-size: 1.55rem; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .badge {
      background: rgba(52, 211, 153, 0.15);
      color: var(--green);
      border: 1px solid rgba(52, 211, 153, 0.4);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 600;
    }
    .badge-rr {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.4);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 20px;
    }
    .card h2 { margin-top: 0; font-size: 1.05rem; color: var(--accent); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    pre {
      background: #070a12;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      font-size: 0.8rem;
      color: #cbd5e1;
      margin: 8px 0 0;
    }
    .btn-sm {
      background: #1e293b;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 11px;
      font-size: 0.76rem;
      cursor: pointer;
      font-weight: 600;
    }
    .btn-sm:hover { background: #334155; }
    .btn-danger { color: var(--red); border-color: rgba(248,113,113,0.4); }
    .btn-green { background: rgba(52,211,153,0.18); color: var(--green); border-color: rgba(52,211,153,0.4); }
    input, select, textarea, button.primary {
      width: 100%;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #070a12;
      color: var(--text);
      font-size: 0.88rem;
      margin-bottom: 10px;
    }
    button.primary {
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: #0b0f19;
      font-weight: 700;
      border: none;
      cursor: pointer;
      margin-bottom: 0;
    }
    button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .table-wrap {
      overflow-x: auto;
      max-height: 520px;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td {
      text-align: left;
      padding: 9px 11px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    th { background: #0f1626; position: sticky; top: 0; z-index: 1; }
    tr:hover { background: rgba(255,255,255,0.03); }
    code.id {
      color: var(--accent);
      background: rgba(56, 189, 248, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    .status-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .st-active { background: rgba(52,211,153,0.15); color: var(--green); }
    .st-exhausted { background: rgba(248,113,113,0.15); color: var(--red); }
    .st-cooldown { background: rgba(251,191,36,0.15); color: var(--yellow); }
    .st-disabled { background: rgba(148,163,184,0.15); color: var(--muted); }
    .form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      align-items: end;
      margin-bottom: 12px;
    }
    .progress-bar-bg {
      width: 100%;
      height: 12px;
      background: #070a12;
      border: 1px solid var(--border);
      border-radius: 999px;
      overflow: hidden;
      margin: 10px 0;
    }
    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent), var(--green));
      transition: width 0.2s ease;
    }
    .stat-box {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      font-size: 0.85rem;
      margin-top: 6px;
    }
    .stat-item {
      background: #0b1120;
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>
          Twix AI Router
          <span class="badge">${catalogModels.length} Models</span>
          <span class="badge-rr">Unlimited Round-Robin + 1-Click Bulk Tester</span>
        </h1>
        <div style="color: var(--muted); font-size: 0.88rem; margin-top: 4px;">
          Multi-Key Auto-Failover &amp; Sequential Bulk Model Tester — Base URL: <code>${PUBLIC_URL}/v1</code>
        </div>
      </div>
    </header>

    <!-- 1-CLICK BULK TEST ALL 391 MODELS -->
    <div class="card" style="border-color: rgba(56, 189, 248, 0.5);">
      <h2>
        <span>⚡ 1-Click Bulk Test Semua Model (Bergantian / Sequential)</span>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-sm btn-green" onclick="copyWorkingModels()">Copy Daftar Model yang OK</button>
          <button class="btn-sm" onclick="exportBulkResults()">Download Hasil JSON</button>
        </div>
      </h2>

      <div style="display: grid; grid-template-columns: 2fr 1fr 1fr 1.4fr 0.8fr; gap: 10px; align-items: end;">
        <div>
          <label style="font-size:0.75rem;color:var(--muted)">Prompt Simpel</label>
          <input id="bt-prompt" value="hallo" style="margin-bottom:0" />
        </div>
        <div>
          <label style="font-size:0.75rem;color:var(--muted)">Target Model</label>
          <select id="bt-scope" style="margin-bottom:0">
            <option value="all">Semua Model di Tabel (${catalogModels.length})</option>
            <option value="filtered">Hanya yang Difilter di Tabel</option>
            <option value="featured">Hanya Featured Models (${featured.length})</option>
          </select>
        </div>
        <div>
          <label style="font-size:0.75rem;color:var(--muted)">Mode Giliran (Worker)</label>
          <select id="bt-concurrency" style="margin-bottom:0">
            <option value="1" selected>1 per 1 Bergantian (Sequential)</option>
            <option value="2">2 Model Bergantian</option>
            <option value="3">3 Model Bergantian</option>
          </select>
        </div>
        <div>
          <button class="primary" id="bt-start-btn" onclick="startBulkTest()">🚀 Mulai Bulk Test ("hallo")</button>
        </div>
        <div>
          <button class="btn-sm btn-danger" id="bt-stop-btn" onclick="stopBulkTest()" style="width:100%; padding:10px;" disabled>⏹ Stop</button>
        </div>
      </div>

      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="bt-progress"></div>
      </div>

      <div class="stat-box">
        <div class="stat-item">Status: <strong id="bt-state" style="color:var(--accent)">Siap</strong></div>
        <div class="stat-item">Progress: <strong id="bt-count">0 / ${catalogModels.length}</strong></div>
        <div class="stat-item" style="color:var(--green)">✅ Berhasil (OK): <strong id="bt-ok">0</strong></div>
        <div class="stat-item" style="color:var(--red)">❌ Gagal: <strong id="bt-fail">0</strong></div>
        <div class="stat-item">Sedang Dites: <code id="bt-current">-</code></div>
      </div>
    </div>

    <!-- MODELS TABLE WITH LIVE BULK TEST RESULTS -->
    <div class="card">
      <h2>
        <span>Katalog Semua ${catalogModels.length} Model &amp; Hasil Live Test</span>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn-sm" onclick="setStatusFilter('all')">Semua</button>
          <button class="btn-sm btn-green" onclick="setStatusFilter('ok')">Hanya yang OK ✅</button>
          <button class="btn-sm btn-danger" onclick="setStatusFilter('fail')">Hanya yang Gagal ❌</button>
        </div>
      </h2>
      <input id="search" placeholder="Cari model atau provider (contoh: claude, gpt-6, gemini, deepseek, qwen)..." oninput="filterModels()" />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Model ID</th>
              <th>Provider</th>
              <th>Status Test</th>
              <th>Latency</th>
              <th>Jawaban Model / Detail Error</th>
              <th>Tes Satuan</th>
            </tr>
          </thead>
          <tbody id="model-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- MULTI API KEY POOL MANAGER -->
    <div class="card">
      <h2>
        <span>Pool API Key (Round-Robin &amp; Auto-Failover Tanpa Batas)</span>
        <div>
          <button class="btn-sm" onclick="resetAllKeys()">Reset Semua Status ke Active</button>
          <button class="btn-sm" onclick="loadKeys()">Refresh</button>
        </div>
      </h2>

      <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; margin-bottom: 14px;">
        <div style="background:#0b1120; padding:14px; border-radius:10px; border:1px solid var(--border);">
          <div style="font-weight:600; font-size:0.88rem; margin-bottom:8px;">+ Tambah Satu API Key</div>
          <div class="form-row">
            <div>
              <label style="font-size:0.75rem;color:var(--muted)">Nama / Label Key</label>
              <input id="k-name" placeholder="Misal: OpenRouter Key #1" style="margin-bottom:0" />
            </div>
            <div>
              <label style="font-size:0.75rem;color:var(--muted)">Provider</label>
              <select id="k-provider" onchange="onProviderChange()" style="margin-bottom:0">
                <option value="openrouter">OpenRouter (Semua Model)</option>
                <option value="openai">OpenAI Direct</option>
                <option value="anthropic">Anthropic Direct</option>
                <option value="gemini">Google Gemini (OpenAI-compat)</option>
                <option value="groq">Groq</option>
                <option value="deepseek">DeepSeek</option>
                <option value="9router">9Router Upstream</option>
                <option value="custom">Custom OpenAI Base URL</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div>
              <label style="font-size:0.75rem;color:var(--muted)">Base URL Upstream</label>
              <input id="k-baseurl" value="https://openrouter.ai/api/v1" style="margin-bottom:0" />
            </div>
            <div>
              <label style="font-size:0.75rem;color:var(--muted)">API Key</label>
              <input id="k-secret" placeholder="sk-..." style="margin-bottom:0" />
            </div>
          </div>
          <button class="primary" onclick="addSingleKey()">Tambahkan ke Pool Round-Robin</button>
        </div>

        <div style="background:#0b1120; padding:14px; border-radius:10px; border:1px solid var(--border);">
          <div style="font-weight:600; font-size:0.88rem; margin-bottom:8px;">+ Bulk Import Banyak API Key Sekaligus (Unlimited)</div>
          <label style="font-size:0.75rem;color:var(--muted)">Paste daftar API Key (1 baris = 1 key, atau format <code>nama|provider|key</code>)</label>
          <textarea id="k-bulk" rows="3" placeholder="sk-or-v1-key1...\nsk-or-v1-key2...\nKey Ketiga|openai|sk-proj-..." style="margin-bottom:8px"></textarea>
          <button class="primary" onclick="addBulkKeys()">Import Semua Key</button>
        </div>
      </div>

      <div class="table-wrap" style="max-height: 260px;">
        <table>
          <thead>
            <tr>
              <th>Urutan</th>
              <th>Nama Key</th>
              <th>Provider &amp; Base URL</th>
              <th>Key (Masked)</th>
              <th>Status</th>
              <th>Req / Sukses / Gagal</th>
              <th>Error Terakhir</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody id="keys-tbody">
            <tr><td colspan="8">Memuat pool API Key...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- CURL EXAMPLES -->
    <div class="grid">
      <div class="card" style="margin-bottom:0">
        <h2><span>1. Chat Completions (Round-Robin)</span><button class="btn-sm" onclick="copyPre('curl-openai')">Copy</button></h2>
        <pre id="curl-openai">curl -X POST "${PUBLIC_URL}/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "google/gemini-4-argon",
    "messages": [{"role": "user", "content": "hallo"}]
  }'</pre>
      </div>

      <div class="card" style="margin-bottom:0">
        <h2><span>2. Endpoint Test 1 Model Cepat</span><button class="btn-sm" onclick="copyPre('curl-testone')">Copy</button></h2>
        <pre id="curl-testone">curl -X POST "${PUBLIC_URL}/api/models/test" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "google/gemini-2.5-flash-lite", "prompt": "hallo"}'</pre>
      </div>
    </div>
  </div>

  <script>
    const MODELS = ${JSON.stringify(catalogModels)};
    const TEST_RESULTS = {}; // modelId -> { status: 'testing'|'ok'|'fail', latencyMs, reply, error, keyUsed }
    let currentStatusFilter = 'all';
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

    function getFilteredModels() {
      const q = (document.getElementById('search')?.value || '').toLowerCase();
      return MODELS.filter(m => {
        const matchText =
          m.id.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q) ||
          m.providerDisplay.toLowerCase().includes(q);
        if (!matchText) return false;
        if (currentStatusFilter === 'ok') return TEST_RESULTS[m.id]?.status === 'ok';
        if (currentStatusFilter === 'fail') return TEST_RESULTS[m.id]?.status === 'fail';
        return true;
      });
    }

    function setStatusFilter(f) {
      currentStatusFilter = f;
      filterModels();
    }

    function renderStatusBadge(id) {
      const r = TEST_RESULTS[id];
      if (!r) return '<span class="status-pill st-disabled">BELUM DITES</span>';
      if (r.status === 'testing') return '<span class="status-pill st-cooldown">⏳ TESTING...</span>';
      if (r.status === 'ok') return '<span class="status-pill st-active">✅ OK</span>';
      return '<span class="status-pill st-exhausted">❌ GAGAL</span>';
    }

    function renderRows(list) {
      const tbody = document.getElementById('model-tbody');
      tbody.innerHTML = list.map((m, i) => {
        const r = TEST_RESULTS[m.id];
        const lat = r?.latencyMs ? r.latencyMs + ' ms' : '-';
        const detail = r
          ? (r.status === 'ok'
              ? '<span style="color:var(--green)">' + escapeHtml(r.reply) + '</span>'
              : '<span style="color:var(--red)">' + escapeHtml(r.error) + '</span>')
          : '<span style="color:var(--muted)">' + escapeHtml(m.displayName) + ' ($' + (m.inputCost ?? 0) + '/$' + (m.outputCost ?? 0) + ')</span>';
        const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        return \`
          <tr id="row-\${safeId}">
            <td>\${i + 1}</td>
            <td><code class="id">\${m.id}</code> \${m.featured ? '⭐' : ''}</td>
            <td>\${m.providerDisplay}</td>
            <td id="st-\${safeId}">\${renderStatusBadge(m.id)}</td>
            <td id="lat-\${safeId}">\${lat}</td>
            <td id="det-\${safeId}" style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="\${escapeHtml(r?.reply || r?.error || '')}">\${detail}</td>
            <td><button class="btn-sm" onclick="testSingleModel('\${m.id}')">Tes</button></td>
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
          detEl.innerHTML = '<span style="color:var(--yellow)">Mengirim prompt...</span>';
        } else if (r.status === 'ok') {
          detEl.innerHTML = '<span style="color:var(--green)">' + escapeHtml(r.reply) + '</span>';
          detEl.title = r.reply || '';
        } else {
          detEl.innerHTML = '<span style="color:var(--red)">' + escapeHtml(r.error) + '</span>';
          detEl.title = r.error || '';
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
          body: JSON.stringify({ model: modelId, prompt })
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
        TEST_RESULTS[modelId] = {
          status: 'fail',
          latencyMs: 0,
          error: err.message
        };
      }
      updateSingleRowDOM(modelId);
      return TEST_RESULTS[modelId];
    }

    async function startBulkTest() {
      if (bulkRunning) return;
      const scope = document.getElementById('bt-scope').value;
      const prompt = document.getElementById('bt-prompt').value.trim() || 'hallo';
      const concurrency = Number(document.getElementById('bt-concurrency').value) || 1;

      let queue = [];
      if (scope === 'featured') {
        queue = MODELS.filter(m => m.featured);
      } else if (scope === 'filtered') {
        queue = getFilteredModels();
      } else {
        queue = [...MODELS];
      }

      if (queue.length === 0) return alert('Tidak ada model untuk dites.');

      bulkRunning = true;
      bulkStopRequested = false;
      document.getElementById('bt-start-btn').disabled = true;
      document.getElementById('bt-stop-btn').disabled = false;
      document.getElementById('bt-state').innerText = 'Sedang Berjalan (Bergantian)...';

      let completed = 0;
      let okCount = 0;
      let failCount = 0;
      const total = queue.length;
      let cursor = 0;

      function refreshCounters(currId) {
        const pct = Math.round((completed / total) * 100);
        document.getElementById('bt-progress').style.width = pct + '%';
        document.getElementById('bt-count').innerText = completed + ' / ' + total + ' (' + pct + '%)';
        document.getElementById('bt-ok').innerText = okCount;
        document.getElementById('bt-fail').innerText = failCount;
        if (currId) document.getElementById('bt-current').innerText = currId;
      }

      refreshCounters('-');

      async function worker() {
        while (!bulkStopRequested) {
          const idx = cursor++;
          if (idx >= total) break;
          const m = queue[idx];
          refreshCounters(m.id);

          // Auto scroll row inside table container smoothly every few items
          const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
          const rowEl = document.getElementById('row-' + safeId);
          if (rowEl && concurrency === 1) {
            rowEl.scrollIntoView({ block: 'nearest' });
          }

          const result = await testSingleModel(m.id, prompt);
          completed++;
          if (result.status === 'ok') okCount++;
          else failCount++;
          refreshCounters(m.id);
        }
      }

      const workers = [];
      for (let w = 0; w < concurrency; w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      bulkRunning = false;
      document.getElementById('bt-start-btn').disabled = false;
      document.getElementById('bt-stop-btn').disabled = true;
      document.getElementById('bt-state').innerText = bulkStopRequested ? 'Dihentikan' : 'Selesai ✅';
      document.getElementById('bt-current').innerText = '-';
      loadKeys();
    }

    function stopBulkTest() {
      bulkStopRequested = true;
      document.getElementById('bt-state').innerText = 'Menghentikan...';
    }

    function copyWorkingModels() {
      const working = Object.entries(TEST_RESULTS)
        .filter(([, v]) => v.status === 'ok')
        .map(([k]) => k);
      if (working.length === 0) return alert('Belum ada model berstatus OK.');
      navigator.clipboard.writeText(working.join('\\n'));
      alert(working.length + ' Model ID yang OK berhasil disalin ke clipboard!');
    }

    function exportBulkResults() {
      const blob = new Blob([JSON.stringify(TEST_RESULTS, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'twix-router-bulk-test-results.json';
      a.click();
    }

    function onProviderChange() {
      const p = document.getElementById('k-provider').value;
      if (PROVIDER_URLS[p]) {
        document.getElementById('k-baseurl').value = PROVIDER_URLS[p];
      }
    }

    async function loadKeys() {
      const res = await fetch('/api/keys');
      const data = await res.json();
      const tbody = document.getElementById('keys-tbody');
      if (!data.keys || data.keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8">Belum ada API Key di pool.</td></tr>';
        return;
      }
      tbody.innerHTML = data.keys.map((k, idx) => {
        let stClass = 'st-active';
        let stLabel = k.status.toUpperCase();
        if (!k.enabled) { stClass = 'st-disabled'; stLabel = 'DISABLED'; }
        else if (k.status === 'exhausted') { stClass = 'st-exhausted'; stLabel = 'HABIS / EXHAUSTED'; }
        else if (k.status === 'cooldown') { stClass = 'st-cooldown'; stLabel = 'RATE LIMIT COOLDOWN'; }

        return \`
          <tr>
            <td>#\${idx + 1} (ID: \${k.id})</td>
            <td><strong>\${k.name}</strong></td>
            <td>\${k.provider} <br/><span style="color:var(--muted);font-size:0.74rem">\${k.base_url}</span></td>
            <td><code>\${k.masked_key}</code></td>
            <td><span class="status-pill \${stClass}">\${stLabel}</span></td>
            <td>\${k.total_requests} req (\${k.success_count} ok / \${k.fail_count} err)</td>
            <td style="color:var(--red);font-size:0.75rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;">\${k.last_error || '-'}</td>
            <td>
              <button class="btn-sm" onclick="toggleKey(\${k.id}, \${!k.enabled})">\${k.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn-sm" onclick="resetKey(\${k.id})">Reset</button>
              <button class="btn-sm btn-danger" onclick="deleteKey(\${k.id})">Hapus</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    async function addSingleKey() {
      const name = document.getElementById('k-name').value.trim() || 'API Key';
      const provider = document.getElementById('k-provider').value;
      const base_url = document.getElementById('k-baseurl').value.trim();
      const api_key = document.getElementById('k-secret').value.trim();
      if (!api_key) return alert('Masukkan API Key terlebih dahulu!');
      await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, provider, base_url, api_key })
      });
      document.getElementById('k-name').value = '';
      document.getElementById('k-secret').value = '';
      loadKeys();
    }

    async function addBulkKeys() {
      const raw = document.getElementById('k-bulk').value.trim();
      if (!raw) return alert('Paste minimal 1 baris API key!');
      const provider = document.getElementById('k-provider').value;
      const base_url = document.getElementById('k-baseurl').value.trim();
      const lines = raw.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
      const keys = lines.map((line, i) => {
        if (line.includes('|')) {
          const parts = line.split('|').map(s => s.trim());
          if (parts.length >= 3) {
            const p = parts[1].toLowerCase();
            return { name: parts[0], provider: p, base_url: PROVIDER_URLS[p] || base_url, api_key: parts[2] };
          }
        }
        return { name: \`Bulk Key #\${i + 1}\`, provider, base_url, api_key: line };
      });
      await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys })
      });
      document.getElementById('k-bulk').value = '';
      loadKeys();
    }

    async function toggleKey(id, enabled) {
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled })
      });
      loadKeys();
    }

    async function resetKey(id) {
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'reset' })
      });
      loadKeys();
    }

    async function resetAllKeys() {
      await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_all' })
      });
      loadKeys();
    }

    async function deleteKey(id) {
      await fetch(\`/api/keys?id=\${id}\`, { method: 'DELETE' });
      loadKeys();
    }

    function copyPre(id) {
      const text = document.getElementById(id).innerText;
      navigator.clipboard.writeText(text);
    }

    loadKeys();
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
    const path = parsedUrl.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    // 1. Health check
    if (method === 'GET' && (path === '/health' || path === '/api/health')) {
      const keys = await getAllKeys();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 'healthy',
          models: catalogModels.length,
          keyPoolSize: keys.length,
          activeKeys: keys.filter((k) => k.enabled && k.status === 'active').length,
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

    // 3. Fast Single-Model Test Endpoint (used by 1-Click Sequential Bulk Tester)
    if (method === 'POST' && path === '/api/models/test') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const modelId = String(body.model ?? 'google/gemini-2.5-flash-lite');
      const prompt = String(body.prompt ?? 'hallo');
      const found = catalogModels.find((m) => m.id === modelId);
      const isImageOnly =
        found &&
        found.outputTypes?.includes('image') &&
        !found.outputTypes?.includes('text');

      const t0 = Date.now();
      try {
        if (isImageOnly) {
          const cleanModel = modelId.replace(/^openai\//, '');
          const { upstream, usedKey } = await executeWithRoundRobinFailover(
            'images',
            { model: cleanModel, prompt, n: 1, size: '1024x1024' },
            undefined,
            25000
          );
          const latencyMs = Date.now() - t0;
          const json = (await upstream.json()) as Record<string, unknown>;
          if (upstream.ok) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                model: modelId,
                latencyMs,
                keyUsed: `#${usedKey.id} (${usedKey.name})`,
                reply: '[Image Model OK]',
              })
            );
            return;
          }
          const errMsg =
            (json?.error as { message?: string })?.message ??
            JSON.stringify(json).slice(0, 140);
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
        }

        const { upstream, usedKey } = await executeWithRoundRobinFailover(
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
          // non-json error
        }

        if (upstream.ok) {
          const choices = json.choices as
            | Array<{ message?: { content?: string; reasoning?: string } }>
            | undefined;
          const reply =
            choices?.[0]?.message?.content ||
            choices?.[0]?.message?.reasoning ||
            'OK (empty text)';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              model: modelId,
              latencyMs,
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

    // 4. API Key Pool Management CRUD (/api/keys)
    if (path === '/api/keys') {
      if (method === 'GET') {
        const keys = await getAllKeys();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            total: keys.length,
            nextRoundRobinIndex: rrIndex,
            keys: keys.map((k) => ({
              ...k,
              api_key: undefined,
              masked_key: maskKey(k.api_key),
            })),
          })
        );
        return;
      }

      if (method === 'POST' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const items: Array<{
          name?: string;
          provider?: string;
          base_url?: string;
          api_key: string;
        }> = Array.isArray(body.keys) ? body.keys : [body];

        let inserted = 0;
        for (const item of items) {
          if (!item.api_key) continue;
          const prov = (item.provider ?? 'openrouter').toLowerCase();
          const bUrl =
            item.base_url?.trim() ||
            PROVIDER_DEFAULTS[prov] ||
            'https://openrouter.ai/api/v1';
          const name = item.name?.trim() || `${prov} key`;
          await sql`
            INSERT INTO api_keys (name, provider, base_url, api_key, enabled, status)
            VALUES (${name}, ${prov}, ${bUrl}, ${item.api_key.trim()}, true, 'active')
          `;
          inserted++;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inserted }));
        return;
      }

      if (method === 'PATCH' && sql) {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.action === 'reset_all') {
          await sql`
            UPDATE api_keys
            SET status = 'active', cooldown_until = 0, last_error = NULL
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (body.action === 'reset' && body.id) {
          await sql`
            UPDATE api_keys
            SET status = 'active', cooldown_until = 0, last_error = NULL
            WHERE id = ${Number(body.id)}
          `;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (body.id !== undefined && typeof body.enabled === 'boolean') {
          await sql`
            UPDATE api_keys
            SET enabled = ${body.enabled}
            WHERE id = ${Number(body.id)}
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

    // 5. GET /v1/models & /v1/models/image & /v1/models/info
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

    // 6. POST /v1/chat/completions
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

      const { upstream, usedKey, attempts } = await executeWithRoundRobinFailover(
        'chat',
        payload
      );

      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      res.writeHead(upstream.status, {
        'content-type': contentType,
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

    // 7. POST /v1/messages
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

      const { upstream, usedKey, attempts } = await executeWithRoundRobinFailover(
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

    // 8. POST /v1/images/generations
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

      const { upstream, usedKey, attempts } = await executeWithRoundRobinFailover(
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
          'x-router-key-used': `#${usedKey.id} (${usedKey.name})`,
          'x-router-attempts': JSON.stringify(attempts),
        });
        res.end(imgBuf);
        return;
      }

      res.writeHead(upstream.status, {
        'content-type': 'application/json',
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
          message: `Route ${method} ${path} not found. Available: GET /v1/models, POST /v1/chat/completions, POST /v1/messages, POST /v1/images/generations, POST /api/models/test, GET/POST/PATCH/DELETE /api/keys`,
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
  console.log(`[webserver] Twix AI Router (Round-Robin + Bulk Tester) listening on :${PORT}`);
});
