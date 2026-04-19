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
  // 1. Validate PIN
  const pin = request.headers.get('X-Access-Pin');
  if (!pin || pin !== env.ACCESS_PIN) {
    return jsonResponse({ error: 'Unauthorized' }, 401, env);
  }

  // 2. Rate limit by IP
  const ip = request.headers.get('CF-Connecting-IP') || 'dev';
  const rateResult = await checkRateLimit(ip, env);
  if (!rateResult.allowed) {
    return jsonResponse({ error: 'Rate limit exceeded. Maximum 20 analyses per day.' }, 429, env);
  }

  // 3. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }

  const pdfBase64 = body.pdf;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return jsonResponse({ error: 'Missing pdf field' }, 400, env);
  }

  // 4. Size check (~10MB base64 = ~14M chars)
  if (pdfBase64.length > 14_000_000) {
    return jsonResponse({ error: 'File too large. Maximum 10MB.' }, 400, env);
  }

  // 5. PDF magic bytes: base64 of "%PDF" starts with "JVBER"
  if (!pdfBase64.startsWith('JVBER')) {
    return jsonResponse({ error: 'Invalid file type. Please upload a PDF.' }, 400, env);
  }

  // 6. Call Claude Sonnet
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
            },
            {
              type: 'text',
              text: `Analyze this Carfax vehicle history report. Return a JSON object with exactly these fields:
{
  "vin": "VIN from report",
  "vehicle": "Year Make Model Trim",
  "title_status": "Clean|Salvage|Rebuilt|Lemon|Flood|Junk",
  "title_clean": true/false,
  "owner_count": number,
  "usage_type": "Personal|Rental|Fleet|Commercial|Lease|Unknown",
  "accident_count": number,
  "accident_details": ["description of each accident/damage event"],
  "structural_damage": true/false,
  "airbag_deployed": true/false,
  "odometer_ok": true/false,
  "odometer_readings": [{"date": "YYYY-MM", "miles": number}],
  "flood_damage": true/false,
  "state_history": ["states registered in"],
  "service_history_regular": true/false,
  "open_recalls": ["recall descriptions"],
  "risk_rating": "GREEN|YELLOW|RED",
  "risk_summary": "one sentence overall risk summary",
  "red_flags": ["specific concerns found"],
  "green_flags": ["specific positives found"],
  "seller_questions": ["questions to ask seller based on findings"],
  "overall_assessment": "2-3 sentence plain-English assessment"
}
Return ONLY valid JSON. No markdown, no backticks, no explanation.`
            }
          ]
        }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: 'Failed to reach Claude API' }, 502, env);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: 'Claude API error', detail: errText.slice(0, 300) }, 502, env);
  }

  const data = await claudeRes.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());
    return jsonResponse(analysis, 200, env);
  } catch {
    return jsonResponse({ raw: text, error: 'Could not parse Claude response as JSON' }, 200, env);
  }
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
