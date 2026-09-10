// Smoke test: boots the demo server, runs the licensing flow against the
// test workspace (enter -> state PRO -> gated feature -> clear), then cleans
// up. Required env: KEYMINT_TEST_ADMIN_API_KEY, KEYMINT_TEST_CLIENT_API_KEY,
// KEYMINT_TEST_PRODUCT_ID. Skips quietly when absent (PR runs).
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const adminKey = process.env.KEYMINT_TEST_ADMIN_API_KEY;
const clientKey = process.env.KEYMINT_TEST_CLIENT_API_KEY;
const productId = process.env.KEYMINT_TEST_PRODUCT_ID;
const keymintBase = process.env.KEYMINT_TEST_BASE_URL || 'https://api.keymint.dev';

if (!adminKey || !clientKey || !productId) {
  console.log('smoke: credentials not set, skipping');
  process.exit(0);
}

const PORT = '4101';
const runId = randomUUID().replaceAll('-', '');
let licenseKey = null;
let server = null;

async function api(path, { method = 'GET', body, key } = {}) {
  const res = await fetch(`${keymintBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function local(path, opts = {}) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function assert(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
}

async function waitHealth(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await local('/health');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server never became healthy');
}

try {
  const created = await api('/key', {
    method: 'POST',
    key: adminKey,
    body: { productId, maxActivations: '3', metadata: { purpose: 'notemate-smoke', runId } },
  });
  assert(created.status === 200, 'create', created.status);
  licenseKey = created.json.key;

  server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: 'server',
    env: {
      ...process.env,
      PORT,
      KEYMINT_ACCESS_TOKEN: clientKey,
      KEYMINT_PRODUCT_ID: productId,
    },
    stdio: 'ignore',
  });
  await waitHealth();
  console.log('PASS boot');

  const entered = await local('/api/enter-license', {
    method: 'POST',
    body: { licenseKey, deviceTag: 'smoke' },
  });
  assert(entered.status === 200 && entered.json.tier === 'PRO', 'enter-license', entered.status);

  const state = await local('/api/license-state');
  assert(state.json.tier === 'PRO', 'license-state');

  const feat = await local('/api/feature/exportPDF');
  assert(feat.status === 200, 'gated feature');

  const cleared = await local('/api/clear-license', { method: 'POST' });
  assert(cleared.json.tier === 'FREE', 'clear-license');

  const gated = await local('/api/feature/exportPDF');
  assert(gated.status === 402, 'gate after clear');
} catch (e) {
  console.log('FAIL exception', e?.message || e);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  if (licenseKey) {
    const blocked = await api('/key/block', {
      method: 'POST',
      key: adminKey,
      body: { productId, licenseKey },
    });
    console.log(`${blocked.status === 200 ? 'PASS' : 'FAIL'} cleanup-block`);
    if (blocked.status !== 200) process.exitCode = 1;
  }
}
