// Central frontend API wrapper
// Provides: api.fetchWithCsrf, api.get, api.post, api.put, api.delete

const api = (function(){
  const RETRYABLE_STATUSES = [502, 503, 504];

  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || null;
  }

  async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchWithCsrf(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});

    const token = getCsrfToken();
    if (token) headers['CSRF-Token'] = token;

    const opts = Object.assign({}, options, { headers, credentials: 'same-origin' });

    // Safe methods and mutations carrying a durable request identity may retry.
    // Reuse the same options object so every attempt preserves the exact key/body.
    const hasIdempotencyKey = Object.keys(headers)
      .some(name => name.toLowerCase() === 'idempotency-key' && headers[name]);
    const maxAttempts = (method === 'GET' || method === 'HEAD' || hasIdempotencyKey) ? 3 : 1;
    let attempt = 0;
    let lastErr = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const res = await fetch(url, opts);

        // Authentication / authorization handling
        if (res.status === 401) {
          // Not authenticated — redirect to login
          window.location.href = '/';
          throw new Error('Not authenticated');
        }

        if (res.status === 403) {
          // Try to detect CSRF issues first
          try {
            const data = await res.json();
            const msg = (data?.error || '') + '';
            if (msg.toLowerCase().includes('csrf')) {
              // Reload page to refresh session
              window.location.reload();
              throw new Error('CSRF token invalid, reloading');
            }

            // Non-CSRF 403 — likely insufficient permissions
            if (msg) {
              // Notify user and navigate away from privileged pages
              try { alert('Access denied: ' + msg); } catch (_) {}
            } else {
              try { alert('Access denied'); } catch (_) {}
            }
            window.location.href = '/dashboard';
            throw new Error('Insufficient permissions');
          } catch (parseErr) {
            // If parsing fails, still redirect to dashboard
            window.location.href = '/dashboard';
            throw new Error('Insufficient permissions');
          }
        }

        // If retryable status, and attempts remaining, backoff and retry
        if (RETRYABLE_STATUSES.includes(res.status) && attempt < maxAttempts) {
          const backoff = Math.pow(2, attempt) * 250 + Math.floor(Math.random()*100);
          await delay(backoff);
          continue;
        }

        return res;
      } catch (err) {
        lastErr = err;
        // network error — if retryable and attempts left, backoff
        if (attempt < maxAttempts) {
          const backoff = Math.pow(2, attempt) * 250 + Math.floor(Math.random()*100);
          await delay(backoff);
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error('Fetch failed');
  }

  async function parseJsonSafe(res) {
    if (!res) throw new Error('No response');
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    fetchWithCsrf,
    parseJsonSafe,
    async get(url, options) {
      const res = await fetchWithCsrf(url, Object.assign({ method: 'GET' }, options));
      return res;
    },
    async post(url, body, options) {
      const res = await fetchWithCsrf(url, Object.assign({ method: 'POST', body: JSON.stringify(body) }, options));
      return res;
    },
    async put(url, body, options) {
      const res = await fetchWithCsrf(url, Object.assign({ method: 'PUT', body: JSON.stringify(body) }, options));
      return res;
    },
    async del(url, options) {
      const res = await fetchWithCsrf(url, Object.assign({ method: 'DELETE' }, options));
      return res;
    }
  };
})();

// Expose globally for legacy scripts
window.api = api;
window.fetchWithCsrf = api.fetchWithCsrf;
