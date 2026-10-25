'use strict';
/**
 * ReviveBench license validation (Windows side).
 *
 * The Lemon Squeezy call lives behind a tiny provider interface so a future
 * swap (Paddle / Polar / Stripe Managed Payments) is a 1-file change:
 * add a factory to `providers` below and point `license.provider` in
 * branding.json at it. The rest of the app only ever sees the normalized
 * result shape returned by `service.validate(code)`:
 *
 *   {
 *     ok: boolean,          // true ONLY when the code is usable right now
 *     reason: string|void,  // machine-ish reason when ok === false
 *     message: string,      // human text for the UI (always present)
 *     status: string|void,  // provider status (active/expired/disabled/...)
 *     remaining: number|null, // unlocks left, null = provider says unlimited
 *     limit: number|null,
 *     usage: number|null
 *   }
 *
 * FAIL-CLOSED: every error path (network down, timeout, bad JSON, HTTP 429/5xx,
 * unknown status) returns ok:false. Callers must never treat a thrown error or
 * a missing field as success.
 */

const DEFAULTS = {
  provider: 'lemonsqueezy',
  baseUrl: 'https://api.lemonsqueezy.com/v1',
  endpoints: {
    validate: '/licenses/validate',
    activate: '/licenses/activate',
    deactivate: '/licenses/deactivate'
  },
  timeoutMs: 15000,
  minRequestIntervalMs: 1500
};

function fail(reason, message, extra) {
  return Object.assign(
    { ok: false, reason, message, status: undefined, remaining: null, limit: null, usage: null },
    extra || {}
  );
}

function mergeConfig(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  cfg.endpoints = Object.assign({}, DEFAULTS.endpoints, (config && config.endpoints) || {});
  cfg.baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  return cfg;
}

function endpointUrl(cfg, name) {
  const ep = cfg.endpoints[name];
  if (!ep) throw new Error('missing endpoint: ' + name);
  if (/^https?:\/\//i.test(ep)) return ep; // absolute override allowed
  return cfg.baseUrl + (ep.charAt(0) === '/' ? ep : '/' + ep);
}

/* ------------------------------------------------------------------ */
/* Ownership gate (fail closed)                                        */
/*                                                                     */
/* Lemon Squeezy's /licenses/validate answers for keys from ANY store  */
/* on their platform. Their own docs warn: verify store_id /          */
/* product_id / variant_id in `meta` against YOUR product, otherwise   */
/* "someone using a license key from another Lemon Squeezy product     */
/* could use it to get access to your product." So: unconfigured IDs   */
/* and mismatched IDs both reject the code.                            */
/* ------------------------------------------------------------------ */

function toNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function checkOwnership(expect, meta) {
  const e = expect || {};
  if (!toNumOrNull(e.productId)) {
    return fail(
      'not_configured',
      'This copy is not configured for its license product yet (seller setup incomplete) — no code will be accepted.'
    );
  }
  const pairs = [
    ['storeId', e.storeId, meta && meta.store_id],
    ['productId', e.productId, meta && meta.product_id],
    ['variantId', e.variantId, meta && meta.variant_id]
  ];
  for (let i = 0; i < pairs.length; i++) {
    const want = toNumOrNull(pairs[i][1]);
    if (want === null) continue; // that particular ID not pinned
    const got = toNumOrNull(pairs[i][2]);
    if (got === null || got !== want) {
      return fail('wrong_product', 'That license code belongs to a different product.');
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lemon Squeezy provider                                              */
/* ------------------------------------------------------------------ */

function createLemonSqueezyProvider(cfg, deps) {
  const doFetch = deps.fetch || fetch;

  async function post(endpointName, params) {
    const url = endpointUrl(cfg, endpointName);
    const body = new URLSearchParams();
    for (const k of Object.keys(params)) body.append(k, params[k]);

    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json'
      },
      body: body.toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    return res;
  }

  return {
    name: 'lemonsqueezy',

    async validate(licenseKey) {
      let res;
      try {
        res = await post('validate', { license_key: licenseKey });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return fail(
          timedOut ? 'timeout' : 'network',
          timedOut
            ? 'Could not reach the license server (timed out). Check the shop internet connection and try again.'
            : 'Could not reach the license server. Check the shop internet connection and try again.'
        );
      }

      if (res.status === 429) {
        return fail('rate_limited', 'Too many license checks in a row. Wait a few seconds and try again.');
      }

      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        return fail('bad_response', 'License server sent an unreadable response. Try again in a moment.');
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (err) {
        data = null;
      }

      // Lemon Squeezy answers 404 ("license_key not found.") for unknown keys
      // and 422 for a malformed/missing key. Both mean: the code is not usable.
      if (res.status === 404 || res.status === 422) {
        return fail('invalid', 'That license code is not valid. Check for typos and try again.');
      }
      if (!res.ok) {
        const detail = data && (data.error || data.message);
        return fail(
          'http',
          'License server error' + (detail ? ': ' + detail : ' (HTTP ' + res.status + ')') + ' — try again in a moment.'
        );
      }
      if (!data) {
        return fail('bad_response', 'License server sent an unreadable response. Try again in a moment.');
      }

      const lk = data.license_key;
      if (!lk || data.valid !== true) {
        return fail('invalid', 'That license code is not valid. Check for typos and try again.');
      }

      const gate = checkOwnership(cfg.expect, data.meta);
      if (gate) return gate;

      const status = lk.status;
      if (status === 'expired') {
        return fail('expired', 'That license code has expired. Contact support or buy a new code.', { status });
      }
      if (status === 'disabled') {
        return fail('disabled', 'That license code has been disabled. Contact support.', { status });
      }
      if (status !== 'active') {
        // inactive / unknown status => fail closed
        return fail('not_active', 'That license code is not active (status: ' + status + ').', { status });
      }

      const limit = typeof lk.activation_limit === 'number' ? lk.activation_limit : null;
      const usage = typeof lk.activation_usage === 'number' ? lk.activation_usage : null;
      if (limit !== null && usage !== null && usage >= limit) {
        return fail(
          'exhausted',
          'That license code has no unlocks left (' + usage + '/' + limit + ' used).',
          { status, limit, usage, remaining: 0 }
        );
      }

      return {
        ok: true,
        reason: undefined,
        message: 'License OK — ' + (limit === null ? 'unlimited unlocks' : (limit - usage) + ' unlock(s) remaining') + '.',
        status,
        limit,
        usage,
        remaining: limit === null ? null : limit - usage
      };
    },

    // Present for the adapter contract; the burn step (Linux side) is the only
    // caller in the product, this is exposed so the Windows side can grow into it.
    async activate(licenseKey, instanceName) {
      try {
        const res = await post('activate', { license_key: licenseKey, instance_name: instanceName });
        if (!res.ok) return { ok: false, http: res.status };
        const data = await res.json();
        const lk = data && data.license_key;
        return { ok: !!lk, usage: lk && lk.activation_usage, limit: lk && lk.activation_limit };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }
  };
}

const providers = {
  lemonsqueezy: createLemonSqueezyProvider
};

/* ------------------------------------------------------------------ */
/* Service: provider + client-side throttle (LS rate limit 60 req/min) */
/* ------------------------------------------------------------------ */

function createLicenseService(config, deps) {
  const cfg = mergeConfig(config);
  const factory = providers[cfg.provider];
  if (!factory) throw new Error('unknown license provider: ' + cfg.provider);
  const provider = factory(cfg, deps || {});

  let lastCallAt = 0;
  const interval = Math.max(1000, Number(cfg.minRequestIntervalMs) || DEFAULTS.minRequestIntervalMs);

  async function validate(code) {
    const key = String(code == null ? '' : code).trim();
    if (!key) {
      return fail('empty', 'Enter your license code first.');
    }

    // client-side throttle: space out requests so we never trip the 60/min limit
    const now = Date.now();
    const since = now - lastCallAt;
    if (lastCallAt && since < interval) {
      await new Promise((r) => setTimeout(r, interval - since));
    }
    lastCallAt = Date.now();

    try {
      return await provider.validate(key);
    } catch (err) {
      // Belt and braces: nothing escapes as success.
      return fail('error', 'License check failed: ' + (err && err.message ? err.message : err));
    }
  }

  return {
    providerName: provider.name,
    config: { provider: cfg.provider, baseUrl: cfg.baseUrl, endpoints: cfg.endpoints },
    validate,
    activate: provider.activate ? (key, instance) => provider.activate(key, instance) : undefined
  };
}

module.exports = { createLicenseService, providers, mergeConfig, DEFAULTS };
