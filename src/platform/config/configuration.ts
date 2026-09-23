/**
 * Environment → typed config. Also the one place that decides whether the
 * process is allowed to boot at all: `validateEnvironment()` runs before any
 * module is constructed, so a missing live-mode credential fails loudly at
 * startup with an actionable message instead of surfacing as a 500 on the
 * first patient message.
 */

/** Keys that must be present in every environment, whatever the mode. */
const ALWAYS_REQUIRED = ['DATABASE_URL', 'JWT_SECRET'] as const;

/** Keys that must be present only when CLINOPS_MODE=live. */
const LIVE_CLINOPS_REQUIRED = [
  'CLINOPS_BASE_URL',
  'CLINOPS_USERNAME',
  'CLINOPS_PASSWORD',
] as const;

function requireKeys(keys: readonly string[], why: string): string[] {
  return keys.filter((key) => !process.env[key]?.trim()).map((key) => `${key} (${why})`);
}

export function validateEnvironment(): void {
  const mode = resolveClinopsMode();
  const problems: string[] = [...requireKeys(ALWAYS_REQUIRED, 'required in every mode')];
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters');
  }

  if (mode !== 'mock' && mode !== 'live') {
    problems.push(`CLINOPS_MODE must be exactly "mock" or "live" (got "${process.env.CLINOPS_MODE}")`);
  }

  if (mode === 'live') {
    problems.push(...requireKeys(LIVE_CLINOPS_REQUIRED, 'required when CLINOPS_MODE=live'));

    const baseUrl = process.env.CLINOPS_BASE_URL?.trim();
    if (baseUrl && !/^https:\/\//i.test(baseUrl)) {
      problems.push('CLINOPS_BASE_URL must start with https://');
    }
    if (baseUrl?.endsWith('/')) {
      problems.push('CLINOPS_BASE_URL must not end with a trailing slash');
    }
  }

  if (mode === 'mock' && !process.env.CLINOPS_MODE &&
      [process.env.CLINOPS_BASE_URL, process.env.CLINOPS_USERNAME, process.env.CLINOPS_PASSWORD].some(Boolean)) {
    problems.push('Set all ClinOps credentials for live mode, or remove partial credentials for mock mode');
  }

  for (const key of ['CLINOPS_TIMEOUT_MS', 'CLINOPS_TOKEN_TTL_MS', 'PORT'] as const) {
    const raw = process.env[key];
    if (raw !== undefined && raw.trim() !== '' && !Number.isFinite(Number(raw))) {
      problems.push(`${key} must be a number (got "${raw}")`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'Invalid configuration — the application cannot start:\n' +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\n\nFix these in .env (see .env.example) and restart. ' +
        'To run without a ClinOps account, set CLINOPS_MODE=mock.',
    );
  }
}

export function resolveClinopsMode(): string {
  if (process.env.CLINOPS_MODE) return process.env.CLINOPS_MODE.toLowerCase();
  return process.env.CLINOPS_BASE_URL && process.env.CLINOPS_USERNAME && process.env.CLINOPS_PASSWORD
    ? 'live' : 'mock';
}

export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // The one hostname the stack is reachable on. Changing PUBLIC_HOSTNAME in
  // .env moves the API, the dashboard and the allowed CORS origin together —
  // nothing else in the codebase names a host.
  publicHostname: process.env.PUBLIC_HOSTNAME || 'portal.houdaifa.dev',

  // Browser origins allowed to call the admin API. The dashboard is served
  // from the same origin as the API in the shipped setup, so this only
  // matters for a `npm run dev` Vite server on 5173 and for any future
  // separately-hosted dashboard.
  corsOrigins: (
    process.env.CORS_ORIGINS ||
    `http://localhost:5173,http://${process.env.PUBLIC_HOSTNAME || 'portal.houdaifa.dev'}`
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  whatsapp: {
    accessToken:   process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken:   process.env.META_VERIFY_TOKEN,
    appSecret:     process.env.META_APP_SECRET,
    apiVersion:    process.env.META_API_VERSION || 'v20.0',
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },

  clinops: {
    // Credentials select live mode unless CLINOPS_MODE is set explicitly.
    // Mock mode serves local fixtures while WhatsApp remains independently configured.
    mode:       resolveClinopsMode(),
    baseUrl:    process.env.CLINOPS_BASE_URL,
    username:   process.env.CLINOPS_USERNAME,
    password:   process.env.CLINOPS_PASSWORD,
    // Per-request budget. ClinOps is a remote clinic system and some reads are
    // slow; 15s is comfortably above observed round trips while still bounded
    // well under the inbound message worker's own patience.
    timeoutMs:  Number(process.env.CLINOPS_TIMEOUT_MS || 15_000),
    // Local reuse budget for the bearer token. The doc does not publish the
    // token's real lifetime, so this is a conservative cap; the authoritative
    // signal is a 401, which the transport handles by refreshing once and
    // retrying. Kept well under an hour so a rotated credential takes effect
    // without a restart, and well above a burst of patient traffic so the
    // documented 5-requests-per-minute auth rate limit is never approached.
    tokenTtlMs: Number(process.env.CLINOPS_TOKEN_TTL_MS || 900_000),
  },

  campaign: {
    // Approved Meta template used for the outbound opening message. Template
    // names/languages are specific to each WhatsApp Business account, so they
    // must be configurable, never hardcoded in the send path.
    openingTemplateName: process.env.CAMPAIGN_OPENING_TEMPLATE_NAME || 'patient_followup',
    openingTemplateLanguage: process.env.CAMPAIGN_OPENING_TEMPLATE_LANGUAGE || 'fr',
  },
});
