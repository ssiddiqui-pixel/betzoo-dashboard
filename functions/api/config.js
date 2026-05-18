import { loadConfig, saveConfig } from '../_lib/config.js';

// GET /api/config -> { hasSavedKey, sites }
export async function onRequestGet({ env }) {
  const cfg = await loadConfig(env);
  return Response.json({ hasSavedKey: !!cfg.apiKey, sites: cfg.sites || [] });
}

// POST /api/config { apiKey?, sites? }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const cfg = await loadConfig(env);
  if (body.apiKey !== undefined) cfg.apiKey = body.apiKey;
  if (body.sites !== undefined) cfg.sites = body.sites;
  await saveConfig(env, cfg);
  return Response.json({ ok: true });
}
