import 'dotenv/config';

const BASE_DELAY_MS   = 1_000;
const MAX_DELAY_MS    = 8_000;
const MAX_ATTEMPTS    = 5;
const REQUEST_TIMEOUT = 10_000;
const RETRIABLE_CODES = new Set([408, 429, 500, 502, 503, 504]);
const BASE_URL        = 'https://rickandmortyapi.com/api/character';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (level, message, meta = {}) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...meta }));

const getBackoffDelay = (attempt) => {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  return Math.random() * cap;
};

const getDelay = (attempt, response) => {
  const retryAfter = response?.headers?.get('Retry-After');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1_000;
    const date = new Date(retryAfter);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
  }
  return getBackoffDelay(attempt);
};

const fetchWithTimeout = (url, options = {}) => {
  const controller = new AbortController();
  const id         = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
};

const fetchWithRetry = async (url, options = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.API_TOKEN && { Authorization: `Bearer ${process.env.API_TOKEN}` }),
    ...options.headers,
  };

  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    const start = Date.now();
    let response;

    try {
      response = await fetchWithTimeout(url, { ...options, headers });
    } catch (networkError) {
      const isTimeout = networkError.name === 'AbortError';
      if (attempt + 1 >= MAX_ATTEMPTS) throw networkError;

      const delay = getBackoffDelay(attempt);
      log('WARN', isTimeout ? 'Request timed out, retrying' : 'Network error, retrying', {
        error: networkError.message, attempt: attempt + 1, retryInMs: Math.round(delay),
      });
      await sleep(delay);
      attempt++;
      continue;
    }

    if (response.ok) return response.json();
    if ([401, 403].includes(response.status)) throw new Error(`Auth error ${response.status}`);
    if (response.status === 404) throw new Error(`Not found: ${url}`);
    if (!RETRIABLE_CODES.has(response.status)) throw new Error(`Non-retriable HTTP ${response.status}`);

    if (attempt + 1 >= MAX_ATTEMPTS) {
      throw new Error(`All ${MAX_ATTEMPTS} attempts failed (last status: ${response.status})`);
    }

    const delay = getDelay(attempt, response);
    log('WARN', 'Retriable error, backing off', {
      status: response.status, attempt: attempt + 1, retryInMs: Math.round(delay),
    });
    await sleep(delay);
    attempt++;
  }
};