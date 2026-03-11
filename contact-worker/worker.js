/**
 * MollTonCreative Contact Form Worker
 * Empfaengt Formulardaten, validiert sie und leitet an n8n Webhook weiter.
 */

const RATE_LIMIT_SECONDS = 30;
const recentSubmissions = new Map();

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const isAllowed = allowed.includes(origin) || origin?.endsWith('.landinghomepage.pages.dev');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitize(str) {
  return String(str || '').replace(/[<>]/g, '').trim().slice(0, 2000);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin, env);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, origin, env);
    }

    // Validate
    const name = sanitize(body.name);
    const email = sanitize(body.email);
    const material = sanitize(body.material);
    const message = sanitize(body.message);

    if (!name || name.length < 2) {
      return jsonResponse({ error: 'Name ist erforderlich' }, 422, origin, env);
    }
    if (!email || !validateEmail(email)) {
      return jsonResponse({ error: 'Gueltige E-Mail ist erforderlich' }, 422, origin, env);
    }
    if (!message || message.length < 5) {
      return jsonResponse({ error: 'Nachricht ist erforderlich (mind. 5 Zeichen)' }, 422, origin, env);
    }

    // Simple rate limit by IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const lastSubmit = recentSubmissions.get(ip);
    if (lastSubmit && (now - lastSubmit) < RATE_LIMIT_SECONDS * 1000) {
      return jsonResponse({ error: 'Bitte warte kurz vor der naechsten Anfrage' }, 429, origin, env);
    }
    recentSubmissions.set(ip, now);

    // Honeypot check
    if (body.website) {
      return jsonResponse({ ok: true }, 200, origin, env);
    }

    // Forward to n8n webhook
    const webhookUrl = env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      return jsonResponse({ error: 'Server-Konfigurationsfehler' }, 500, origin, env);
    }

    try {
      const n8nResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          material: material || 'Nicht angegeben',
          message,
          timestamp: new Date().toISOString(),
          ip,
          source: 'molltoncreative-landing',
        }),
      });

      if (!n8nResponse.ok) {
        console.error('n8n webhook error:', n8nResponse.status);
        return jsonResponse({ error: 'Nachricht konnte nicht gesendet werden. Bitte versuche es per E-Mail: info@molltoncreative.de' }, 502, origin, env);
      }

      return jsonResponse({ ok: true, message: 'Anfrage erfolgreich gesendet!' }, 200, origin, env);
    } catch (err) {
      console.error('n8n webhook fetch error:', err.message);
      return jsonResponse({ error: 'Server nicht erreichbar. Bitte versuche es per E-Mail: info@molltoncreative.de' }, 502, origin, env);
    }
  },
};
