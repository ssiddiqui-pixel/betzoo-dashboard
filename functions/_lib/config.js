// Cloudflare KV-backed config storage.
// Replaces the fs.readFileSync/writeFileSync calls against config.json.
//
// Requires a KV namespace bound to the Pages project under the variable name
// CONFIG_KV (see wrangler.toml and the Cloudflare dashboard binding).

const KEY = 'config';

export async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get(KEY);
    if (!raw) return { apiKey: '', sites: [] };
    const parsed = JSON.parse(raw);
    return {
      apiKey: parsed.apiKey || '',
      sites: Array.isArray(parsed.sites) ? parsed.sites : []
    };
  } catch {
    return { apiKey: '', sites: [] };
  }
}

export async function saveConfig(env, data) {
  await env.CONFIG_KV.put(KEY, JSON.stringify(data));
}
