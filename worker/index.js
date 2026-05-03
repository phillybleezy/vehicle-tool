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

    if (url.pathname === '/api/listings' && request.method === 'GET') {
      return handleGetListings(request, env);
    }
    if (url.pathname === '/api/listings' && request.method === 'POST') {
      return handlePostListings(request, env);
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
    if (url.pathname === '/api/car-sections' && request.method === 'GET') {
      return handleGetCarSections(request, env);
    }
    if (url.pathname === '/api/car-sections' && request.method === 'POST') {
      return handleCreateCarSection(request, env);
    }

    if (url.pathname === '/api/analyze-vehicle' && request.method === 'POST') {
      return handleAnalyzeVehicle(request, env);
    }

    if (url.pathname === '/api/links' && request.method === 'GET') {
      return handleGetLinks(request, env);
    }
    if (url.pathname === '/api/links' && request.method === 'POST') {
      return handleCreateLink(request, env);
    }
    const linkIdMatch = url.pathname.match(/^\/api\/links\/([^/]+)$/);
    if (linkIdMatch && request.method === 'DELETE') {
      return handleDeleteLink(request, env, linkIdMatch[1]);
    }

    return jsonResponse({ error: 'Not Found' }, 404, env);
  }
};

function authPinOnly(request, env) {
  const pin = (request.headers.get('X-Access-Pin') || '').trim();
  const expected = (env.ACCESS_PIN || '').trim();
  if (!pin || pin !== expected) {
    return { error: jsonResponse({ error: 'Unauthorized' }, 401, env) };
  }
  return { ok: true };
}

function authPinOrScraperToken(request, env) {
  const pinAuth = authPinOnly(request, env);
  if (!pinAuth.error) return pinAuth;

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (env.SCRAPER_TOKEN && token && timingSafeEqual(token, env.SCRAPER_TOKEN)) {
    return { ok: true };
  }

  return pinAuth;
}

function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

async function authAndRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) {
    return { error: jsonResponse({ error: 'Cannot determine client IP' }, 400, env) };
  }
  const rateResult = await checkRateLimit(ip, env);
  if (!rateResult.allowed) {
    return { error: jsonResponse({ error: 'Rate limit exceeded. Maximum 100 analyses per day.' }, 429, env) };
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
  if (data.stop_reason === 'max_tokens') {
    return { error: 'Response was too long — try a more specific trim or model year' };
  }
  const text = data.content?.[0]?.text || '{}';
  try {
    return { analysis: JSON.parse(text.replace(/```json\n?|```/g, '').trim()) };
  } catch {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return { analysis: JSON.parse(match[0]) };
    } catch {}
    return { error: 'Could not parse Claude response as JSON', detail: text.slice(0, 200) };
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
    complaintCount: typeof body.complaintCount === 'number' ? body.complaintCount : 0,
    sectionId: typeof body.sectionId === 'string' && body.sectionId.trim() ? body.sectionId.trim() : null
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
    'vinData','recallCount','recallSummary','complaintCount','sectionId'];
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

async function handleGetListings(request, env) {
  const auth = authPinOrScraperToken(request, env);
  if (auth.error) return auth.error;
  try {
    const raw = await env.LISTINGS.get('listings');
    const lastUpdated = await env.LISTINGS.get('listings_last_updated');
    const listings = raw ? JSON.parse(raw) : [];
    return jsonResponse({ listings, last_updated: lastUpdated || null, count: listings.length }, 200, env);
  } catch {
    return jsonResponse({ error: 'Could not read listings' }, 500, env);
  }
}

async function handlePostListings(request, env) {
  if (!env.SCRAPER_TOKEN) {
    return jsonResponse({ error: 'Service misconfigured' }, 503, env);
  }
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !timingSafeEqual(token, env.SCRAPER_TOKEN)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, env);
  }
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  if (!Array.isArray(body.listings)) {
    return jsonResponse({ error: 'listings must be an array' }, 400, env);
  }
  try {
    await env.LISTINGS.put('listings', JSON.stringify(body.listings));
    await env.LISTINGS.put('listings_last_updated', body.last_updated || new Date().toISOString());
    return jsonResponse({ ok: true, count: body.listings.length }, 200, env);
  } catch {
    return jsonResponse({ error: 'Could not write listings' }, 500, env);
  }
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

// ── Quick Links ──
async function getCarSectionsFromKV(env) {
  const data = await env.SAVED_CARS.get('car_sections');
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Stored section data is corrupt');
  }
}

async function handleGetCarSections(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let sections;
  try { sections = await getCarSectionsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read section data' }, 500, env);
  }
  return jsonResponse(sections, 200, env);
}

async function handleCreateCarSection(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return jsonResponse({ error: 'Section name is required' }, 400, env);
  if (name.length > 60) return jsonResponse({ error: 'Section name is too long' }, 400, env);
  let sections;
  try { sections = await getCarSectionsFromKV(env); } catch {
    return jsonResponse({ error: 'Could not read section data' }, 500, env);
  }
  const section = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString()
  };
  sections.push(section);
  try {
    await env.SAVED_CARS.put('car_sections', JSON.stringify(sections));
  } catch {
    return jsonResponse({ error: 'Could not write section data' }, 500, env);
  }
  return jsonResponse(section, 201, env);
}

// Quick Links
async function getLinksFromKV(env) {
  try {
    const data = await env.SAVED_CARS.get('quick_links');
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

async function handleGetLinks(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  return jsonResponse(await getLinksFromKV(env), 200, env);
}

async function handleCreateLink(request, env) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }
  if (!body.url || !body.title) return jsonResponse({ error: 'url and title required' }, 400, env);
  const links = await getLinksFromKV(env);
  const link = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: String(body.title).slice(0, 200),
    url: String(body.url).slice(0, 2000),
    note: body.note ? String(body.note).slice(0, 500) : '',
    section: body.section ? String(body.section).slice(0, 100) : ''
  };
  links.push(link);
  try {
    await env.SAVED_CARS.put('quick_links', JSON.stringify(links));
  } catch {
    return jsonResponse({ error: 'Could not save link' }, 500, env);
  }
  return jsonResponse(link, 201, env);
}

async function handleDeleteLink(request, env, id) {
  const auth = authPinOnly(request, env);
  if (auth.error) return auth.error;
  const links = await getLinksFromKV(env);
  const filtered = links.filter(l => l.id !== id);
  if (filtered.length === links.length) return jsonResponse({ error: 'Link not found' }, 404, env);
  try {
    await env.SAVED_CARS.put('quick_links', JSON.stringify(filtered));
  } catch {
    return jsonResponse({ error: 'Could not delete link' }, 500, env);
  }
  return jsonResponse({ deleted: true }, 200, env);
}

async function handleAnalyzeVehicle(request, env) {
  const auth = await authAndRateLimit(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, env);
  }

  const { year, make, model, trim } = body;
  if (!year || !make || !model) {
    return jsonResponse({ error: 'year, make, and model are required' }, 400, env);
  }

  const makeEncoded = encodeURIComponent(make);
  const modelEncoded = encodeURIComponent(model);

  const [complaintsRes, recallsRes] = await Promise.allSettled([
    fetch(`https://api.nhtsa.dot.gov/complaints/complaintsByVehicle?make=${makeEncoded}&model=${modelEncoded}&modelYear=${year}`),
    fetch(`https://api.nhtsa.dot.gov/recalls/recallsByVehicle?make=${makeEncoded}&model=${modelEncoded}&modelYear=${year}`)
  ]);

  let complaints = [];
  let recalls = [];

  if (complaintsRes.status === 'fulfilled' && complaintsRes.value.ok) {
    try { const d = await complaintsRes.value.json(); complaints = d.results || []; } catch {}
  }
  if (recallsRes.status === 'fulfilled' && recallsRes.value.ok) {
    try { const d = await recallsRes.value.json(); recalls = d.results || []; } catch {}
  }

  const recallLines = recalls.slice(0, 15).map(r =>
    `- ${r.component || 'Unknown'}: ${(r.summary || r.consequence || r.defect || '').slice(0, 200)}`
  ).join('\n') || 'None found';

  const complaintLines = complaints.slice(0, 25).map(c =>
    `- ${c.components || 'Unknown'}: ${(c.summary || '').slice(0, 150)}`
  ).join('\n') || 'None found';

  const trimLabel = trim ? ` ${trim}` : '';
  const vehicleLabel = `${year} ${make} ${model}${trimLabel}`;
  const complaintCount = complaints.length;
  const recallCount = recalls.length;

  const content = [{
    type: 'text',
    text: `You are a comprehensive automotive expert. Provide a thorough feature breakdown for the ${vehicleLabel}. Use your training knowledge to list ALL standard and optional features for this vehicle model year. Be as specific and complete as possible — do not omit features.

NHTSA DATA (incorporate into known_issues):
Recalls (${recallCount} total):
${recallLines}

Complaints (${complaintCount} total, sample shown):
${complaintLines}

Return a JSON object with exactly these fields (replace all placeholder text with real data):
{
  "vehicle": "${vehicleLabel}",
  "safety": {
    "crash_ratings": "NHTSA and IIHS rating summary for this model year",
    "standard_features": ["every standard safety feature — AEB, lane departure, blind spot, rear cross traffic, backup camera, etc"],
    "optional_features": ["safety features available as options or in packages"],
    "adas_notes": "notes on driver assistance technology suite"
  },
  "technology": {
    "infotainment_system": "system name and screen size(s)",
    "apple_carplay": true,
    "android_auto": true,
    "wireless_carplay": false,
    "wireless_charging": false,
    "standard_features": ["every standard tech feature — touchscreen, Bluetooth, USB ports, navigation, etc"],
    "optional_features": ["optional tech features — premium audio, heads-up display, etc"],
    "notes": "notable technology details"
  },
  "comfort": {
    "seating_material": "cloth/leatherette/leather/SofTex/etc by trim",
    "heated_front_seats": "standard/optional/not available",
    "heated_rear_seats": "standard/optional/not available",
    "ventilated_seats": "standard/optional/not available",
    "sunroof_moonroof": "standard/optional/not available — specify type",
    "cargo_volume_cuft": null,
    "passenger_volume_cuft": null,
    "standard_features": ["all standard comfort features — climate control, power windows, mirrors, seat adjustments, etc"],
    "optional_features": ["optional comfort features"],
    "notes": "cabin quality, noise, ride comfort notes"
  },
  "performance": {
    "engine_options": ["each engine option with displacement, type, and output"],
    "horsepower_range": "X–Y hp",
    "torque_range": "X–Y lb-ft",
    "transmission": "transmission type(s)",
    "mpg_city": null,
    "mpg_highway": null,
    "mpg_combined": null,
    "drivetrain_options": ["FWD", "AWD"],
    "towing_capacity_lbs": null,
    "ground_clearance_inches": null,
    "notes": "performance character notes"
  },
  "exterior": {
    "body_style": "SUV/Sedan/Truck/etc",
    "length_inches": null,
    "width_inches": null,
    "height_inches": null,
    "wheelbase_inches": null,
    "wheel_size_range": "XY–ZW inch",
    "standard_features": ["standard exterior features — LED headlights, fog lights, roof rails, etc"],
    "optional_features": ["optional exterior features"],
    "notes": "styling notes"
  },
  "reliability": {
    "predicted_reliability": "Above Average/Average/Below Average/Unknown",
    "consumer_reports_rating": "score out of 5 or null",
    "jd_power_score": "score out of 100 or null",
    "common_reported_issues": ["specific commonly reported owner issues for this model year"],
    "notes": "overall reliability context and model year specific notes"
  },
  "known_issues": {
    "nhtsa_complaint_count": ${complaintCount},
    "nhtsa_recall_count": ${recallCount},
    "recall_details": ["list recall component and brief description from the NHTSA data above"],
    "top_complaint_areas": ["the component categories with the most NHTSA complaints"],
    "known_problems": ["specific well-documented problems with this model year from owner forums and TSBs"],
    "tsb_notes": "notable technical service bulletins if known",
    "severity": "Minor/Moderate/Serious",
    "notes": "context on whether issues are widespread or isolated"
  },
  "overall_summary": "2-3 sentence overview covering what this vehicle does well and key concerns"
}
Use the exact numbers ${complaintCount} and ${recallCount} for nhtsa_complaint_count and nhtsa_recall_count. Return ONLY valid JSON. No markdown, no backticks, no explanation.`
  }];

  const result = await callClaude(content, 8192, false, env);
  if (result.error) return jsonResponse({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, 502, env);

  if (result.analysis.known_issues) {
    result.analysis.known_issues.nhtsa_complaint_count = complaintCount;
    result.analysis.known_issues.nhtsa_recall_count = recallCount;
  }

  return jsonResponse(result.analysis, 200, env);
}

async function checkRateLimit(ip, env) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  const key = `rate:${ip}:${today}`;
  const existing = await env.RATE_LIMIT.get(key);
  const count = existing ? parseInt(existing) : 0;
  if (count >= 100) return { allowed: false };
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 172800 }); // 48h ensures key outlives the day
  return { allowed: true };
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Pin, Authorization',
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
