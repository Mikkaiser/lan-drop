// LAN Drop relay helper (Cloudflare Worker).
// Hands browsers short-lived Cloudflare TURN credentials, so the long-lived
// TURN key never appears in the public page, plus the caller's public IP.
//
// Spending guard: before issuing credentials it reads the account's TURN usage
// (Cloudflare GraphQL analytics, last 31 days, ingress + egress) and refuses once
// RELAY_LIMIT_GB is reached, so usage stays inside the free 1,000 GB/month.
// If usage can't be read, it also refuses (fail closed).
//
// Secrets: TURN_KEY_ID, TURN_KEY_API_TOKEN, ANALYTICS_API_TOKEN (Account Analytics: Read)
// Vars:    ACCOUNT_ID, RELAY_LIMIT_GB, ALLOWED_ORIGINS

const TTL = 3 * 60 * 60;          // credentials last 3 hours, which bounds overshoot after the limit
const USAGE_CACHE_MS = 5 * 60 * 1000;

let usageCache = { gb: 0, at: 0 }; // per isolate (Cache API isn't available on workers.dev)

async function relayUsageGB(env) {
  if (Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.gb;
  const from = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
  const query = `{ viewer { accounts(filter: { accountTag: "${env.ACCOUNT_ID}" }) {
    callsTurnUsageAdaptiveGroups(filter: { date_geq: "${from}" }, limit: 10000) { sum { egressBytes ingressBytes } }
  } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors?.length) throw new Error(data.errors?.[0]?.message || `HTTP ${res.status}`);
  const groups = data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
  const bytes = groups.reduce((n, g) => n + (g.sum.egressBytes || 0) + (g.sum.ingressBytes || 0), 0);
  usageCache = { gb: bytes / 1e9, at: Date.now() };
  return usageCache.gb;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (status, body) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Only LAN Drop's own pages may ask for credentials (stops other sites using our quota).
    if (!allowed.includes(origin)) return json(403, { error: 'Forbidden' });
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const limitGB = Number(env.RELAY_LIMIT_GB) || 900;
    let usedGB;
    try { usedGB = await relayUsageGB(env); }
    catch (e) { return json(503, { error: `relay usage check failed (${e.message})` }); }
    if (usedGB >= limitGB) {
      return json(429, { error: `monthly relay limit reached (${usedGB.toFixed(1)} of ${limitGB} GB)`, usedGB, limitGB });
    }

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL }),
      },
    );
    if (!res.ok) return json(502, { error: `TURN credentials error (${res.status})` });

    // Also tell the browser its public IP (pages can't see their own), so the host can show it.
    return json(200, {
      ...(await res.json()),
      ip: request.headers.get('CF-Connecting-IP') || '',
      usedGB: Math.round(usedGB * 10) / 10,
      limitGB,
    });
  },
};
