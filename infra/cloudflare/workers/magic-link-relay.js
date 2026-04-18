// File: infra/cloudflare/workers/magic-link-relay.js
// Purpose: Cloudflare Worker — relay magic-link emails via MailChannels API.
// Role: Bridges the singing-bridge server's CloudflareWorkerMailer to
//       MailChannels. Bearer-auth uses timing-safe HMAC compare (Web Crypto).
// Exports: default fetch handler (CF Worker export)
// Invariants: `from` is taken from env.MAIL_FROM only — never from the request
//             body. Missing or wrong Authorization → 401. Upstream failure → 502.
//             Empty Authorization header checked before timingSafeEqual.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  // Import a key for HMAC — identical key means both HMACs are the same length,
  // enabling a constant-time buffer comparison.
  const ka = await crypto.subtle.importKey(
    'raw', enc.encode(a), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', ka, enc.encode(a)),
    crypto.subtle.sign('HMAC', ka, enc.encode(b)),
  ]);
  const va = new Uint8Array(sa);
  const vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') {
      return new Response('', { status: 405 });
    }

    const hdr = req.headers.get('authorization') || '';
    // Explicit empty-header check before timingSafeEqual to avoid
    // leaking timing info on clearly-absent credentials.
    if (!hdr) {
      return new Response('', { status: 401 });
    }
    const expected = 'Bearer ' + env.MAIL_SHARED_SECRET;
    if (!await timingSafeEqual(hdr, expected)) {
      return new Response('', { status: 401 });
    }

    // `from` is never taken from the request body — it comes from the Worker env only.
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return new Response('', { status: 400 });
    }
    const { to, subject, url } = body;
    if (!to || !url) {
      return new Response('', { status: 400 });
    }

    const payload = {
      personalizations: [{
        to: [{ email: to }],
        dkim_domain: env.DKIM_DOMAIN,
        dkim_selector: env.DKIM_SELECTOR,
        dkim_private_key: env.DKIM_PRIVATE_KEY,
      }],
      from: { email: env.MAIL_FROM },  // sender identity is config-only, not request-controlled
      subject: subject || 'Your singing-bridge sign-in link',
      content: [{
        type: 'text/plain',
        value: `Hello,\n\nSign in to singing-bridge by opening this link in the same browser:\n\n${url}\n\nThis link expires in 15 minutes.\n`,
      }],
    };

    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return new Response('', { status: r.ok ? 204 : 502 });
  },
};
