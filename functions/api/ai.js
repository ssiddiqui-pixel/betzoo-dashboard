import { loadConfig } from '../_lib/config.js';

// POST /api/ai -> proxy an Anthropic messages call using the saved API key.
export async function onRequestPost({ request, env }) {
  const cfg = await loadConfig(env);
  if (!cfg.apiKey) return Response.json({ error: 'No API key saved.' }, { status: 400 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: body.messages
      })
    });
    const data = await r.json();
    return Response.json({ text: data.content?.[0]?.text || '', error: data.error?.message });
  } catch (e) {
    return Response.json({ text: '', error: e.message });
  }
}
