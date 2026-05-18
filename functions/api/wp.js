// POST /api/wp -> proxy a single WordPress REST API call with Basic auth.
// Kept for any direct calls from the UI; the main run flow uses helpers
// in _lib/prompts.js directly.
export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { wpUrl, auth, endpoint, method, body: payload } = body;
  if (!wpUrl || !endpoint) {
    return Response.json({ error: 'Missing wpUrl or endpoint' }, { status: 400 });
  }

  try {
    const url = wpUrl.replace(/\/$/, '') + endpoint;
    const opts = {
      method: method || 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(auth || ''),
        'Content-Type': 'application/json'
      }
    };
    if (payload && (method || 'GET') !== 'GET') opts.body = JSON.stringify(payload);
    const r = await fetch(url, opts);
    const text = await r.text();
    try {
      return Response.json(JSON.parse(text));
    } catch {
      return Response.json({ error: 'WP returned non-JSON', raw: text.slice(0, 500) });
    }
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
