const RATE_PER_MIN = parseInt(process.env.WEBFLOW_RATE_LIMIT_PER_MINUTE || "120", 10);
const MIN_INTERVAL_MS = Math.ceil(60000 / Math.max(RATE_PER_MIN, 1));
const SITE_PUBLISH_COOLDOWN_MS = parseInt(
  process.env.WEBFLOW_SITE_PUBLISH_COOLDOWN_MS || "61000",
  10
);

let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = err.response?.status;
  const code = err.response?.data?.code;
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    code === "too_many_requests"
  );
}

function getRetryAfterMs(err) {
  const header = err.response?.headers?.["retry-after"];
  if (!header) return null;
  const seconds = parseInt(header, 10);
  return Number.isNaN(seconds) ? null : seconds * 1000;
}

async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 6,
    baseMs = 1000,
    maxMs = 60000,
    label = "request",
  } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;

      const retryAfterMs = getRetryAfterMs(err);
      const waitMs =
        retryAfterMs ??
        Math.min(maxMs, baseMs * 2 ** attempt) + Math.random() * 250;

      console.warn(
        `[${label}] Rate limited — retry ${attempt + 1}/${maxRetries} in ${Math.round(waitMs)}ms`
      );
      await sleep(waitMs);
      attempt++;
    }
  }
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

async function webflowRequest(fn, options = {}) {
  const { throttle: useThrottle = true, ...retryOpts } = options;
  if (useThrottle) await throttle();
  return retryWithBackoff(fn, retryOpts);
}

module.exports = {
  sleep,
  isRetryable,
  retryWithBackoff,
  throttle,
  webflowRequest,
  MIN_INTERVAL_MS,
  SITE_PUBLISH_COOLDOWN_MS,
};
