export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleCORS(env);
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/analyze-carfax' && request.method === 'POST') {
      return handleCarfaxAnalysis(request, env);
    }
    if (url.pathname === '/api/analyze-nicb' && request.method === 'POST') {
      return handleNICBAnalysis(request, env);
    }
    if (url.pathname === '/api/analyze-listing' && request.method === 'POST') {
      return handleListingAnalysis(request, env);
    }
    if (url.pathname === '/api/analyze-combined' && request.method === 'POST') {
      return handleCombinedAnalysis(request, env);
    }

    if (url.pathname === '/api/cars' && request.method === 'GET') {
      return handleGetCars(request, env);
    }
    if (url.pathname === '/api/cars' && request.method === 'POST') {
      return handleCreateCar(request, env);
    }
    const carIdMatch = url.pathname.match(/^\/api\/cars\/([^/]+)$/);
    if (carIdMatch && request.method === 'PUT') {
      return handleUpdateCar(request, env, carIdMatch[1]);
    }
    if (carIdMatch && request.method === 'DELETE') {
      return handleDeleteCar(request, env, carIdMatch[1]);
    }

    return jsonResponse({ error: 'Not Found' }, 404, env);
  }
};

function authPinOnly(request, env) {
  if (!env.ACCESS_PIN) {
    return { error: jsonResponse({ error: 'Service misconfigured' }, 503, env) };
  }
  const pin = request.headers.get('X-Access-Pin');
  if (!pin || !timingSafeEqual(pin, env.ACCESS_PIN)) {
    return { error: jsonResponse({ error: 'Unauthorized' }, 401, env) };
  }
  return { ok: true };
}

async function authAndRateLimit(request, env) {
  if (!env.ACCESS_PIN) {
    return { error: jsonResponse({ error: 'Service misconfigured' }, 503, env) };
  }
  const pin = request.headers.get('X-Access-Pin');
  if (!pin || !timingSafeEqual(pin, env.ACCESS_PIN)) {
    return { error: jsonResponse({ error: 'Unauthorized' }, 401, env) };
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) {
    return { error: jsonResponse({ error: 'Cannot determine client IP' }, 400, env) };
  }
  const rateResult = await checkRateLimit(ip, env);
  if (!rateResult.allowed) {
    return { error: jsonResponse({ error: 'Rate limit exceeded. Maximum 20 analyses per day.' }, 429, env) };
  }
  return { ok: true };
}

async function callClaude(content, maxTokens, hasPdf, env) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    ...(hasPdf ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {})
  };
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content }] })
    });
  } catch {
    return { error: 'Failed to reach Claude API' };
  }
  if (!res.ok) {
    const errText = await res.text();
    return { error: 'Claude API error', detail: errText.slice(0, 300) };
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  try {
    return { analysis: JSON.parse(text.replace(/```json|```/g, '').trim()) };
  } catch {
    return { error: 'Could not parse Claude response as JSON' };
  }
}

async function handleCarfaxAnalysis(request, env) {
  const auth = await authAndRateLimit(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }

  const CARFAX_PROMPT = `Analyze this Carfax vehicle history report. Return a JSON object with exactly these fields:`;

  // Text-paste mode
  if (typeof body.text === 'string') {
    if (!body.text.trim()) return jsonResponse({ error: 'text field is empty' }, 400, env);
    if (body.text.length > 100_000) return jsonResponse({ error: 'Pasted text too large. Maximum 100,000 characters.' }, 400, env);
    const content = [
      { type: 'text', text: `Here is a Carfax vehicle history report copied as text:\n\n${body.text}` },
      { type: 'text', text: CARFAX_PROMPT + '\n' + `{
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
Return ONLY valid JSON. No markdown, no backticks, no explanation.` }
    ];
    const result = await callClaude(content, 4096, false, env);
    if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
    return jsonResponse(result.analysis, 200, env);
  }

  const pdfBase64 = body.pdf;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return jsonResponse({ error: 'Missing pdf or text field' }, 400, env);
  }
  if (pdfBase64.length > 14_000_000) {
    return jsonResponse({ error: 'File too large. Maximum 10MB.' }, 400, env);
  }
  if (!pdfBase64.startsWith('JVBER')) {
    return jsonResponse({ error: 'Invalid file type. Please upload a PDF.' }, 400, env);
  }

  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
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
  ];

  const result = await callClaude(content, 4096, true, env);
  if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
  return jsonResponse(result.analysis, 200, env);
}

async function handleNICBAnalysis(request, env) {
  const auth = await authAndRateLimit(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }

  const pdfBase64 = body.pdf;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return jsonResponse({ error: 'Missing pdf field' }, 400, env);
  }
  if (pdfBase64.length > 14_000_000) {
    return jsonResponse({ error: 'File too large. Maximum 10MB.' }, 400, env);
  }
  if (!pdfBase64.startsWith('JVBER')) {
    return jsonResponse({ error: 'Invalid file type. Please upload a PDF.' }, 400, env);
  }

  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
    {
      type: 'text',
      text: `This is an NICB VINCheck results page saved as PDF. Extract the key findings and return a JSON object:
{
  "vin": "VIN that was checked",
  "status": "CLEAN|STOLEN|SALVAGE|UNKNOWN",
  "theft_records": number (0 if none),
  "salvage_records": number (0 if none),
  "details": "one sentence describing exactly what was found",
  "summary": "plain English explanation of the result and what it means for a buyer"
}
Return ONLY valid JSON. No markdown, no backticks, no explanation.`
    }
  ];

  const result = await callClaude(content, 1024, true, env);
  if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
  return jsonResponse(result.analysis, 200, env);
}

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const LISTING_PROMPT = `Extract all available information and return a JSON object:
{
  "year": "year or null",
  "make": "make or null",
  "model": "model and trim or null",
  "asking_price": number or null (USD, no $ or commas),
  "mileage": number or null,
  "vin": "VIN if shown or null",
  "condition": "stated condition or null",
  "accident_history": "what seller claims about accident history or null",
  "owner_count": number or null,
  "features": ["notable features and options listed"],
  "seller_type": "Dealer|Private|Unknown",
  "seller_name": "dealer or seller name if shown or null",
  "location": "city, state if shown or null",
  "listing_date": "date listed if shown or null",
  "seller_claims": ["specific claims the seller makes about the vehicle's condition or history"],
  "red_flags": ["anything suspicious or worth verifying: inconsistencies, vague language, missing info that should be there"],
  "questions_to_ask": ["specific questions to ask based on what is and isn't in this listing"],
  "summary": "2-3 sentence plain English summary of this listing and whether it seems straightforward"
}
Return ONLY valid JSON. No markdown, no backticks, no explanation.`;

async function handleListingAnalysis(request, env) {
  const auth = await authAndRateLimit(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }

  // Text-paste mode
  if (typeof body.text === 'string') {
    if (!body.text.trim()) {
      return jsonResponse({ error: 'text field is empty' }, 400, env);
    }
    if (body.text.length > 100_000) {
      return jsonResponse({ error: 'Pasted text too large. Maximum 100,000 characters.' }, 400, env);
    }
    const content = [
      { type: 'text', text: `Here is the car listing content copied from the website:\n\n${body.text}` },
      { type: 'text', text: LISTING_PROMPT }
    ];
    const result = await callClaude(content, 2048, false, env);
    if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
    return jsonResponse(result.analysis, 200, env);
  }

  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    return jsonResponse({ error: 'Missing files array or text field' }, 400, env);
  }
  if (files.length > 10) {
    return jsonResponse({ error: 'Maximum 10 files allowed' }, 400, env);
  }

  const content = [];
  let hasPdf = false;

  for (const file of files) {
    if (!file.data || typeof file.data !== 'string') {
      return jsonResponse({ error: 'Each file must have a data field' }, 400, env);
    }
    if (file.data.length > 14_000_000) {
      return jsonResponse({ error: 'A file exceeds the 10MB limit' }, 400, env);
    }
    if (file.mediaType === 'application/pdf') {
      if (!file.data.startsWith('JVBER')) {
        return jsonResponse({ error: 'Invalid PDF file' }, 400, env);
      }
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
      hasPdf = true;
    } else if (SUPPORTED_IMAGE_TYPES.includes(file.mediaType)) {
      content.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } });
    } else {
      return jsonResponse({ error: `Unsupported file type: ${file.mediaType}` }, 400, env);
    }
  }

  content.push({ type: 'text', text: `These are pages from a car listing (may include multiple tabs/sections saved as separate files). ${LISTING_PROMPT}` });

  const result = await callClaude(content, 2048, hasPdf, env);
  if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
  return jsonResponse(result.analysis, 200, env);
}

async function handleCombinedAnalysis(request, env) {
  const auth = await authAndRateLimit(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  if (!body.carfax || !body.listing) {
    return jsonResponse({ error: 'Missing carfax or listing field' }, 400, env);
  }

  const content = [{
    type: 'text',
    text: `Cross-reference these two documents about the same vehicle being considered for purchase.

CARFAX REPORT ANALYSIS:
${JSON.stringify(body.carfax, null, 2)}

CAR LISTING ANALYSIS:
${JSON.stringify(body.listing, null, 2)}

Compare them carefully. Look for owner count, accident history, mileage, title status, usage type, and any claims the seller made that Carfax can confirm or contradict. Return a JSON object:
{
  "matches": ["facts that match between listing and Carfax, confirming accuracy"],
  "discrepancies": ["contradictions or mismatches — e.g. listing claims 1 owner but Carfax shows 3"],
  "unverified_claims": ["listing claims Carfax neither confirms nor denies"],
  "combined_red_flags": ["red flags only visible when comparing both sources together"],
  "trust_rating": "HIGH|MEDIUM|LOW",
  "trust_summary": "one sentence explaining the trust rating",
  "combined_assessment": "2-3 sentence overall assessment based on everything from both sources",
  "recommended_actions": ["specific next steps before buying based on what was found"]
}
Return ONLY valid JSON. No markdown, no backticks, no explanation.`
  }];

  const result = await callClaude(content, 2048, false, env);
  if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);
  return jsonResponse(result.analysis, 200, env);
}

async function getCarsFromKV(env) {
  const data = await env.SAVED_CARS.get('cars');
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Stored car data is corrupt');
  }
}

async function handleGetCars(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let cars;
  try { cars = await getCarsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read car data' }, 500, env);
  }
  return jsonResponse(cars, 200, env);
}

// Note: KV has no atomic read-modify-write. Concurrent mutations can cause
// lost writes. Acceptable for this personal/family use case.
async function handleCreateCar(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  let cars;
  try { cars = await getCarsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read car data' }, 500, env);
  }
  const car = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    year: body.year || null,
    make: body.make || null,
    model: body.model || null,
    trim: body.trim || null,
    vin: body.vin || null,
    askingPrice: body.askingPrice || null,
    mileage: body.mileage || null,
    listingUrls: Array.isArray(body.listingUrls)
      ? body.listingUrls.filter(u => typeof u === 'string' && u.trim())
      : [],
    carfaxUrl: body.carfaxUrl || null,
    notes: body.notes || '',
    nicbChecked: ['pass','fail'].includes(body.nicbChecked) ? body.nicbChecked : null,
    mvdChecked: ['pass','fail'].includes(body.mvdChecked) ? body.mvdChecked : null,
    carfaxAnalysis: body.carfaxAnalysis || null,
    listingAnalysis: body.listingAnalysis || null,
    combinedAnalysis: body.combinedAnalysis || null,
    vinData: body.vinData || null,
    recallCount: typeof body.recallCount === 'number' ? body.recallCount : 0,
    recallSummary: Array.isArray(body.recallSummary) ? body.recallSummary : [],
    complaintCount: typeof body.complaintCount === 'number' ? body.complaintCount : 0
  };
  cars.push(car);
  try {
    await env.SAVED_CARS.put('cars', JSON.stringify(cars));
  } catch {
    return jsonResponse({ error: 'Could not write car data' }, 500, env);
  }
  return jsonResponse(car, 201, env);
}

async function handleUpdateCar(request, env, id) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  let cars;
  try { cars = await getCarsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read car data' }, 500, env);
  }
  const idx = cars.findIndex(c => c.id === id);
  if (idx === -1) return jsonResponse({ error: 'Car not found' }, 404, env);
  const MUTABLE_FIELDS = ['year','make','model','trim','vin','askingPrice','mileage',
    'listingUrls','carfaxUrl','notes','nicbChecked','mvdChecked',
    'carfaxAnalysis','listingAnalysis','combinedAnalysis',
    'vinData','recallCount','recallSummary','complaintCount'];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => MUTABLE_FIELDS.includes(k))
  );
  cars[idx] = { ...cars[idx], ...updates, id, updatedAt: new Date().toISOString() };
  try {
    await env.SAVED_CARS.put('cars', JSON.stringify(cars));
  } catch {
    return jsonResponse({ error: 'Could not write car data' }, 500, env);
  }
  return jsonResponse(cars[idx], 200, env);
}

async function handleDeleteCar(request, env, id) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let cars;
  try { cars = await getCarsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read car data' }, 500, env);
  }
  const filtered = cars.filter(c => c.id !== id);
  if (filtered.length === cars.length) return jsonResponse({ error: 'Car not found' }, 404, env);
  try {
    await env.SAVED_CARS.put('cars', JSON.stringify(filtered));
  } catch {
    return jsonResponse({ error: 'Could not write car data' }, 500, env);
  }
  return jsonResponse({ deleted: true }, 200, env);
}

async function checkRateLimit(ip, env) {
  const key = `rate:${ip}`;
  const existing = await env.RATE_LIMIT.get(key);
  const count = existing ? parseInt(existing) : 0;
  if (count >= 20) return { allowed: false };
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 86400 });
  return { allowed: true };
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i] ^ bBuf[i];
  return diff === 0;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Pin',
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

function handleCORS(env) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(env), 'Access-Control-Max-Age': '86400' }
  });
}
