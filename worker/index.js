export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleCORS(env);
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/analyze-carfax' && request.method === 'POST') {
      return handleCarfaxAnalysis(request, env);
    }

    return jsonResponse({ error: 'Not Found' }, 404, env);
  }
};

async function handleCarfaxAnalysis(request, env) {
  return jsonResponse({ message: 'stub — not yet implemented' }, 200, env);
}

async function checkRateLimit(ip, env) {
  const key = `rate:${ip}`;
  const existing = await env.RATE_LIMIT.get(key);
  const count = existing ? parseInt(existing) : 0;

  if (count >= 20) {
    return { allowed: false };
  }

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 86400 });
  return { allowed: true, remaining: 19 - count };
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Pin',
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env)
    }
  });
}

function handleCORS(env) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(env),
      'Access-Control-Max-Age': '86400'
    }
  });
}
