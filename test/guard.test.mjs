import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuard, validateConfig, PROJECT_REF, SITE_URL, SUPABASE_URL, END_EXCLUSIVE_UTC } from '../scripts/guard.mjs';

const START = Date.parse('2026-10-15T12:00:00Z');
const TOKEN = 'sbp_fc_TEST_SECRET_DO_NOT_PRINT';
const CONFIG = {
  app: 'meal-studio',
  supabaseUrl: SUPABASE_URL,
  rpc: 'meal_health_check',
  publishableKey: 'sb_publishable_PublicTestOnly',
  representativeImage: '/foods/rice07-3d.webp',
};
const PROJECT_ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function harness({ statuses = ['ACTIVE_HEALTHY'], start = START, restore, config = CONFIG, getProject, databaseTime, imageBytes } = {}) {
  let time = start;
  const calls = [];
  const sleeps = [];
  const queue = [...statuses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === PROJECT_ENDPOINT) {
      if (getProject) return getProject(calls.filter(call => call.url === PROJECT_ENDPOINT).length);
      return json({ id: PROJECT_REF, status: queue.length > 1 ? queue.shift() : queue[0] });
    }
    if (url === `${PROJECT_ENDPOINT}/restore`) return restore ? restore() : json({});
    if (url === `${SITE_URL}/`) return new Response('<title>내가 디자인한 채식식단</title>');
    if (url === `${SITE_URL}/monitor-config.json`) return json(config);
    if (url === `${SITE_URL}${CONFIG.representativeImage}`) return new Response(imageBytes ?? new TextEncoder().encode('RIFF1234WEBPpayload'));
    if (url === `${SUPABASE_URL}/rest/v1/rpc/meal_health_check`) return json({ app: 'meal-studio', status: 'ok', checked_at: databaseTime ?? new Date(time).toISOString() });
    throw new Error(`Unexpected request ${url}`);
  };
  const options = {
    fetchImpl,
    now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms; },
    env: { SUPABASE_RECOVERY_TOKEN: TOKEN },
  };
  return { options, calls, sleeps };
}

test('the expiry boundary stops all network calls, even when a token is absent', async () => {
  const h = harness({ start: Date.parse(END_EXCLUSIVE_UTC) });
  const report = await runGuard({ ...h.options, env: {} });
  assert.equal(report.status, 'FINISHED');
  assert.equal(h.calls.length, 0);
});

test('healthy project checks actual game, config, WebP, and fresh DB without recovery', async () => {
  const h = harness();
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.equal(report.managementVerified, true);
  assert.equal(report.recovery.attempted, false);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(report.checks.length, 5);
  assert.equal(h.calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  for (const call of h.calls.slice(1)) {
    assert.equal(call.options.headers?.Authorization, undefined);
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(h.calls.at(-1).options.headers.apikey, CONFIG.publishableKey);
});

test('INACTIVE causes exactly one restore and waits for verified healthy status and DB', async () => {
  const h = harness({ statuses: ['INACTIVE', 'COMING_UP', 'ACTIVE_HEALTHY'] });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.recovery, { attempted: true, outcome: 'resumed', acknowledged: true });
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.calls.filter(call => call.url === PROJECT_ENDPOINT).length, 3);
  assert.equal(report.checks.at(-1).name, 'database-health');
});

test('a project already transitioning is only polled and never sent restore', async () => {
  const h = harness({ statuses: ['RESTORING', 'COMING_UP', 'ACTIVE_HEALTHY'] });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.equal(report.recovery.attempted, false);
  assert.equal(report.recovery.outcome, 'healthy-after-existing-transition');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('management 401 fails once and does not retry or attempt recovery', async () => {
  const h = harness({ getProject: () => json({ message: TOKEN }, 401) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'HTTP_401');
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
});

test('management rate/quota refusal does not loop', async () => {
  const h = harness({ getProject: () => json({}, 429) });
  const report = await runGuard(h.options);
  assert.equal(report.error.code, 'HTTP_429');
  assert.equal(h.calls.length, 1);
});

test('transient GET failure is retried; authentication is kept only on management requests', async () => {
  const h = harness({ getProject: count => count === 1 ? json({}, 503) : json({ id: PROJECT_REF, status: 'ACTIVE_HEALTHY' }) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.equal(h.calls.filter(call => call.url === PROJECT_ENDPOINT).length, 2);
  assert.deepEqual(h.sleeps, [1000]);
});

test('an ambiguous recovery network response is not retried; read-only polls can confirm it', async () => {
  const h = harness({ statuses: ['INACTIVE', 'INACTIVE', 'COMING_UP', 'ACTIVE_HEALTHY'], restore: () => { throw new Error(`network ${TOKEN}`); } });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.equal(report.recovery.acknowledged, false);
  assert.equal(report.recovery.outcome, 'resumed');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
});

test('recovery 503 is not reissued and can be confirmed through healthy readback', async () => {
  const h = harness({ statuses: ['INACTIVE', 'ACTIVE_HEALTHY'], restore: () => json({ message: TOKEN }, 503) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'PASS');
  assert.equal(report.recovery.acknowledged, false);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('recovery authorization failure exits immediately without polling or duplicate POST', async () => {
  const h = harness({ statuses: ['INACTIVE'], restore: () => json({ message: TOKEN }, 403) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'HTTP_403');
  assert.equal(h.calls.length, 2);
  assert.equal(h.sleeps.length, 0);
});

test('an unconfirmed recovery times out within eight minutes with only one POST', async () => {
  const h = harness({ statuses: ['INACTIVE'], restore: () => { throw new Error('disconnected'); } });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'RECOVERY_TIMEOUT');
  assert.equal(report.recovery.outcome, 'unconfirmed');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(h.sleeps.reduce((sum, ms) => sum + ms, 0) <= 480000);
});

test('crossing the end date while waiting prevents subsequent network requests', async () => {
  const h = harness({ statuses: ['COMING_UP'], start: Date.parse(END_EXCLUSIVE_UTC) - 5000 });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FINISHED');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, [5000]);
});

test('health-only needs no token and expressly does not prove management or recovery access', async () => {
  const h = harness();
  const report = await runGuard({ ...h.options, healthOnly: true, env: {} });
  assert.equal(report.status, 'PASS');
  assert.equal(report.mode, 'health-only');
  assert.equal(report.managementVerified, false);
  assert.equal(report.recovery.outcome, 'not-tested');
  assert.equal(h.calls.some(call => call.url.startsWith('https://api.supabase.com/')), false);
});

test('missing token blocks management without falling back to a false healthy success', async () => {
  const h = harness();
  const report = await runGuard({ ...h.options, env: {} });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'MISSING_RECOVERY_TOKEN');
  assert.equal(h.calls.length, 0);
});

test('untrusted configuration cannot redirect requests or leak either credential', async t => {
  for (const changed of [
    { supabaseUrl: 'https://attacker.example' },
    { supabaseUrl: `${SUPABASE_URL}.attacker.example` },
    { representativeImage: '//attacker.example/foods/rice07-3d.webp' },
    { representativeImage: '/foods/../secret-3d.webp' },
    { representativeImage: '/foods/rice07-3d.webp?redirect=elsewhere' },
    { rpc: 'arbitrary_write' },
    { publishableKey: TOKEN },
  ]) {
    await t.test(Object.keys(changed)[0] + JSON.stringify(changed).length, async () => {
      const h = harness({ config: { ...CONFIG, ...changed } });
      const report = await runGuard(h.options);
      assert.equal(report.status, 'FAIL');
      assert.equal(report.error.code, 'UNTRUSTED_CONFIG');
      assert.equal(h.calls.length, 3);
      assert.equal(JSON.stringify(report).includes(TOKEN), false);
    });
  }
});

test('the complete report redacts provider error text including the token', async () => {
  const h = harness({ getProject: () => { throw new Error(`Authorization: Bearer ${TOKEN}`); } });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'NETWORK_ERROR');
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
  assert.equal(JSON.stringify(report).includes('Authorization'), false);
  assert.equal(h.calls.length, 3);
});

test('unknown provider status strings are not echoed into the report', async () => {
  const h = harness({ getProject: () => json({ id: PROJECT_REF, status: TOKEN }) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'PROJECT_NOT_RECOVERABLE');
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
  assert.equal(h.calls.length, 1);
});

test('stale or forged DB health fails instead of treating HTTP 200 as success', async () => {
  const h = harness({ databaseTime: new Date(START - 300001).toISOString() });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'STALE_DATABASE_HEALTH');
});

test('a successful HTTP response with HTML instead of image bytes fails', async () => {
  const h = harness({ imageBytes: '<html>not an image</html>' });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'INVALID_IMAGE');
});

test('a different Management API project never triggers a restore', async () => {
  const h = harness({ getProject: () => json({ id: 'another-project', status: 'INACTIVE' }) });
  const report = await runGuard(h.options);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.error.code, 'UNEXPECTED_PROJECT');
  assert.equal(h.calls.length, 1);
});

test('configuration validation returns only the minimum public routing fields', () => {
  assert.deepEqual(validateConfig(CONFIG), {
    publishableKey: CONFIG.publishableKey,
    imageUrl: `${SITE_URL}${CONFIG.representativeImage}`,
  });
});
