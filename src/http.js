import { sleep } from './util.js';

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', headers = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const retryDelay = (attempt, error) => {
  const retryAfter = Number(error?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 20_000);
  return Math.min(500 * (2 ** attempt) + Math.floor(Math.random() * 250), 8_000);
};

export const requestJson = async (url, {
  method = 'GET', headers = {}, body, timeoutMs = 8_000, retries = 2,
} = {}) => {
  let lastError;
  const retryableMethod = method === 'GET' || method === 'HEAD';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { 'accept': 'application/json', 'user-agent': 'Nexio-v6/6.6', ...headers },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} from ${new URL(url).host}`, {
          status: response.status, body: text.slice(0, 500), headers: response.headers,
        });
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`Invalid JSON from ${new URL(url).host}`, { status: response.status, body: text.slice(0, 500) });
      }
    } catch (error) {
      lastError = error;
      const retryableStatus = [0, 408, 418, 425, 429, 500, 502, 503, 504].includes(error?.status ?? 0);
      if (!retryableMethod || !retryableStatus || attempt >= retries) throw error;
      await sleep(retryDelay(attempt, error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
};
