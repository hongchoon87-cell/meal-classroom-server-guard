import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const PROJECT_REF = 'gbfyekootswcelavkkpe';
export const SITE_URL = 'https://green-meal-classroom-jw.dailybible-2026.chatgpt.site';
export const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
export const END_EXCLUSIVE_UTC = '2026-11-30T15:00:00Z';
const END_TIME = Date.parse(END_EXCLUSIVE_UTC);
const PROJECT_ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const HEALTH_RPC = 'meal_health_check';
const POLL_LIMIT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const RETRYABLE_GET_STATUSES = new Set([500, 502, 503, 504]);
const POLLABLE_STATUSES = new Set([
  'INACTIVE', 'COMING_UP', 'RESTORING', 'RESTARTING', 'RESIZING',
  'UPGRADING', 'PAUSING', 'GOING_DOWN', 'ACTIVE_UNHEALTHY',
]);

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function publicError(error) {
  // Never copy provider bodies, URLs, credentials, or native error messages to logs.
  return error instanceof GuardError
    ? { code: error.code, message: error.message }
    : { code: 'UNEXPECTED_ERROR', message: 'The check failed unexpectedly; no provider details were logged.' };
}

export function validateConfig(candidate) {
  const valid = candidate && !Array.isArray(candidate)
    && candidate.app === 'meal-studio'
    && candidate.supabaseUrl === SUPABASE_URL
    && candidate.rpc === HEALTH_RPC
    && typeof candidate.publishableKey === 'string'
    && /^sb_publishable_[A-Za-z0-9_-]{8,200}$/.test(candidate.publishableKey)
    && typeof candidate.representativeImage === 'string'
    && /^\/foods\/[a-z0-9]+-3d\.webp$/.test(candidate.representativeImage);
  if (!valid) throw new GuardError('UNTRUSTED_CONFIG', 'The public monitor configuration does not match the fixed project and allowed paths.');
  const imageUrl = new URL(candidate.representativeImage, SITE_URL);
  if (imageUrl.origin !== SITE_URL) throw new GuardError('UNTRUSTED_CONFIG', 'The representative image must stay on the game origin.');
  return {
    publishableKey: candidate.publishableKey,
    imageUrl: imageUrl.href,
  };
}

/**
 * Dependency injection is for deterministic tests. Runtime credentials come only
 * from the SUPABASE_RECOVERY_TOKEN environment variable, never CLI arguments.
 */
export async function runGuard({
  healthOnly = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = milliseconds => delay(milliseconds),
  env = process.env,
} = {}) {
  const report = {
    status: 'FAIL',
    mode: healthOnly ? 'health-only' : 'management-and-health',
    startedAt: new Date(now()).toISOString(),
    projectRef: PROJECT_REF,
    endExclusiveUtc: END_EXCLUSIVE_UTC,
    managementVerified: false,
    recovery: { attempted: false, outcome: healthOnly ? 'not-tested' : 'not-needed' },
    checks: [],
  };

  function checkTime(windowEnd = END_TIME) {
    if (now() >= END_TIME) throw new GuardError('MONITORING_FINISHED', 'Monitoring ended at 2026-12-01 00:00 Asia/Seoul.');
    if (now() >= windowEnd) throw new GuardError('RECOVERY_TIMEOUT', 'The project did not become healthy within the bounded recovery window.');
  }

  async function boundedSleep(milliseconds, windowEnd = END_TIME) {
    checkTime(windowEnd);
    await sleep(Math.min(milliseconds, END_TIME - now(), windowEnd - now()));
    checkTime(windowEnd);
  }

  async function request(url, options = {}, { retryGet = true, windowEnd = END_TIME } = {}) {
    const attempts = retryGet && (options.method ?? 'GET') === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      checkTime(windowEnd);
      let response;
      try {
        response = await fetchImpl(url, {
          ...options,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, END_TIME - now(), windowEnd - now()))),
        });
      } catch {
        if (attempt + 1 === attempts) throw new GuardError('NETWORK_ERROR', 'A network request failed or timed out.');
        await boundedSleep(1000 * (2 ** attempt), windowEnd);
        continue;
      }
      if (attempt + 1 < attempts && RETRYABLE_GET_STATUSES.has(response.status)) {
        await boundedSleep(1000 * (2 ** attempt), windowEnd);
        continue;
      }
      return response;
    }
  }

  function requireStatus(response, label, expected = 200) {
    if (response.status !== expected) {
      throw new GuardError(`HTTP_${response.status}`, `${label} returned HTTP ${response.status}.`);
    }
  }

  async function readJson(response, label) {
    try { return await response.json(); }
    catch { throw new GuardError('INVALID_JSON', `${label} did not return valid JSON.`); }
  }

  let managementHeaders;
  async function readProject(windowEnd = END_TIME) {
    const response = await request(PROJECT_ENDPOINT, { headers: managementHeaders }, { windowEnd });
    requireStatus(response, 'Project status');
    const project = await readJson(response, 'Project status');
    if (!project || (project.ref ?? project.id) !== PROJECT_REF || typeof project.status !== 'string') {
      throw new GuardError('UNEXPECTED_PROJECT', 'The Management API did not return the fixed target project.');
    }
    if (project.status !== 'ACTIVE_HEALTHY' && !POLLABLE_STATUSES.has(project.status)) {
      throw new GuardError('PROJECT_NOT_RECOVERABLE', 'The project is in a state this monitor will not change.');
    }
    report.managementVerified = true;
    report.projectStatus = project.status;
    return project.status;
  }

  async function waitUntilHealthy(status, windowEnd) {
    // INACTIVE here is deliberately read-only, including after an uncertain POST.
    for (let poll = 0; poll < 33 && status !== 'ACTIVE_HEALTHY'; poll += 1) {
      if (!POLLABLE_STATUSES.has(status)) throw new GuardError('PROJECT_NOT_RECOVERABLE', 'The project is in a state this monitor will not change.');
      await boundedSleep(POLL_INTERVAL_MS, windowEnd);
      status = await readProject(windowEnd);
    }
    if (status !== 'ACTIVE_HEALTHY') throw new GuardError('RECOVERY_TIMEOUT', 'The project did not become healthy within the bounded recovery window.');
    return status;
  }

  async function checkPublicHealth() {
    const site = await request(`${SITE_URL}/`);
    requireStatus(site, 'Public game');
    let html;
    try { html = await site.text(); }
    catch { throw new GuardError('INVALID_SITE', 'The game page could not be read.'); }
    if (!html.includes('내가 디자인한 채식식단')) throw new GuardError('INVALID_SITE', 'The public game did not return its expected title.');
    report.checks.push({ name: 'public-game', status: 'PASS', httpStatus: 200 });

    const configResponse = await request(`${SITE_URL}/monitor-config.json`);
    requireStatus(configResponse, 'Monitor configuration');
    const contentType = configResponse.headers.get('content-type') ?? '';
    if (!/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
      throw new GuardError('INVALID_CONFIG_TYPE', 'The monitor configuration did not return JSON content.');
    }
    const config = validateConfig(await readJson(configResponse, 'Monitor configuration'));
    report.checks.push({ name: 'monitor-config', status: 'PASS', httpStatus: 200 });

    const image = await request(config.imageUrl);
    requireStatus(image, 'Food image');
    let bytes;
    try { bytes = new Uint8Array(await image.arrayBuffer()); }
    catch { throw new GuardError('INVALID_IMAGE', 'The food image could not be read.'); }
    const ascii = new TextDecoder('ascii');
    if (bytes.length <= 12 || ascii.decode(bytes.slice(0, 4)) !== 'RIFF' || ascii.decode(bytes.slice(8, 12)) !== 'WEBP') {
      throw new GuardError('INVALID_IMAGE', 'The food image did not contain WebP bytes.');
    }
    report.checks.push({ name: 'food-image', status: 'PASS', httpStatus: 200, bytes: bytes.length });

    // The existing SQL STABLE RPC is read-only and supports GET. The Management
    // token is intentionally absent; only the existing public client key is sent.
    const database = await request(`${SUPABASE_URL}/rest/v1/rpc/${HEALTH_RPC}`, { headers: { apikey: config.publishableKey } });
    requireStatus(database, 'Database health');
    const result = await readJson(database, 'Database health');
    const checkedAt = Date.parse(result?.checked_at);
    if (result?.status !== 'ok' || result?.app !== 'meal-studio' || !Number.isFinite(checkedAt) || Math.abs(now() - checkedAt) > 300000) {
      throw new GuardError('STALE_DATABASE_HEALTH', 'The database did not return a valid fresh health response.');
    }
    report.checks.push({ name: 'database-health', status: 'PASS', httpStatus: 200, checkedAt: new Date(checkedAt).toISOString() });
  }

  try {
    checkTime();
    if (!healthOnly) {
      const token = env.SUPABASE_RECOVERY_TOKEN;
      if (typeof token !== 'string' || !/^sbp_fc[A-Za-z0-9_-]+$/.test(token)) {
        throw new GuardError('MISSING_RECOVERY_TOKEN', 'SUPABASE_RECOVERY_TOKEN must contain a project-scoped PAT in the server secret environment.');
      }
      managementHeaders = { Authorization: `Bearer ${token}` };
      let status = await readProject();
      const windowEnd = Math.min(now() + POLL_LIMIT_MS, END_TIME);
      if (status === 'INACTIVE') {
        report.recovery = { attempted: true, outcome: 'requested', acknowledged: false };
        let response;
        try {
          response = await request(`${PROJECT_ENDPOINT}/restore`, { method: 'POST', headers: managementHeaders }, { retryGet: false, windowEnd });
        } catch (error) {
          if (!(error instanceof GuardError) || error.code !== 'NETWORK_ERROR') throw error;
          report.recovery.outcome = 'response-uncertain';
        }
        if (response) {
          if (response.status >= 500) {
            report.recovery.outcome = 'response-uncertain';
          } else if (!response.ok) {
            requireStatus(response, 'Project recovery');
          } else {
            report.recovery.acknowledged = true;
          }
        }
        status = await waitUntilHealthy(status, windowEnd);
        report.recovery.outcome = 'resumed';
      } else if (status !== 'ACTIVE_HEALTHY') {
        report.recovery.outcome = 'existing-transition';
        status = await waitUntilHealthy(status, windowEnd);
        report.recovery.outcome = 'healthy-after-existing-transition';
      }
      report.checks.push({ name: 'management-project', status: 'PASS', projectStatus: status });
    }
    await checkPublicHealth();
    report.status = 'PASS';
  } catch (error) {
    report.error = publicError(error);
    report.status = report.error.code === 'MONITORING_FINISHED' ? 'FINISHED' : 'FAIL';
    if (report.recovery.attempted && report.recovery.outcome !== 'resumed') report.recovery.outcome = 'unconfirmed';
  }
  report.completedAt = new Date(now()).toISOString();
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const report = args.some(arg => arg !== '--health-only')
    ? { status: 'FAIL', error: { code: 'INVALID_ARGUMENT', message: 'Only --health-only is supported; secrets must use the environment.' } }
    : await runGuard({ healthOnly: args.includes('--health-only') });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
}
