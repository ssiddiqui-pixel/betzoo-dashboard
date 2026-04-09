const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { apiKey: '', sites: [] }; }
}
function saveConfig(data) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }

// ---- Config endpoints ----
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({ hasSavedKey: !!cfg.apiKey, sites: cfg.sites || [] });
});

app.post('/api/config', (req, res) => {
  const cfg = loadConfig();
  if (req.body.apiKey !== undefined) cfg.apiKey = req.body.apiKey;
  if (req.body.sites !== undefined) cfg.sites = req.body.sites;
  saveConfig(cfg);
  res.json({ ok: true });
});

// ---- WP proxy (kept for any direct calls) ----
app.post('/api/wp', async (req, res) => {
  const { wpUrl, auth, endpoint, method, body } = req.body;
  try {
    const url = wpUrl.replace(/\/$/, '') + endpoint;
    const opts = {
      method: method || 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(auth).toString('base64'),
        'Content-Type': 'application/json'
      }
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.json({ error: 'WP returned non-JSON', raw: text.slice(0, 500) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- AI proxy (kept for any direct calls) ----
app.post('/api/ai', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.apiKey) return res.status(400).json({ error: 'No API key saved.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: req.body.messages })
    });
    const data = await r.json();
    res.json({ text: data.content?.[0]?.text || '', error: data.error?.message });
  } catch(e) { res.json({ text: '', error: e.message }); }
});

// ============================================================
// RUN HELPERS
// ============================================================

const BANNED = ['casino','gambling','betting','wager','real money','deposit','withdrawal','odds','slots','payout','jackpot','jackpots','bonus','bonuses','wins','winnings','prize','prizes','rewards'];
const TESTIMONIAL_NAMES = ['Ayla T', 'Remi K', 'Kian S', 'Noor J', 'Teo M', 'Mira L', 'Joss P', 'Leif R', 'Zara W', 'Suki B'];
const BUILT_IN_TYPES = new Set(['post','page','attachment','revision','nav_menu_item','custom_css','customize_changeset','oembed_cache','user_request','wp_block','wp_template','wp_template_part','wp_global_styles','wp_navigation','wp_font_family','wp_font_face']);


function parseJSON(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in response');
  return JSON.parse(clean.slice(start, end + 1));
}
function parseJSONArray(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('['), end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in response');
  return JSON.parse(clean.slice(start, end + 1));
}

function sysCtx(brand, siteType) {
  const isSocial = siteType === 'social-en';
  if (isSocial) return `You write content for "${brand}", a FREE-TO-PLAY social gaming website for adults 21+. No real money involved.
BANNED (never use): casino, gambling, betting, wager, real money, deposit, withdrawal, odds, slots, payout, jackpot, bonus, wins, winnings, prize, prizes, rewards.
SAFE: social gaming, browser games, free-to-play, virtual credits, entertainment, community, instant play, fun, secure, engage.
Tone: friendly, modern, community-focused.`;
  const lang = { 'casino-fr': 'French', 'casino-dk': 'Danish', 'casino-pt': 'Portuguese', 'casino-de': 'German' }[siteType] || 'English';
  return `You write content for "${brand}", a licensed casino review and comparison site. Language: ${lang}. Tone: professional, informative, regulatory-compliant. Include responsible gambling references where appropriate.`;
}

function buildBatchPrompt(fields, brand, siteType, pageSlug = '') {
  const ctx = sysCtx(brand, siteType);
  const isSocial = siteType === 'social-en';
  const fieldGuides = fields.map(({ key, value }) => {
    const k = key.toLowerCase();
    let g = '';
    if (k.includes('hero_title') || (k === 'title' && pageSlug === 'home')) g = 'MAX 6 WORDS. No full sentences. Punchy, impactful. No punctuation at end.';
    else if (k === 'hero_subtitle') {
      if (/^home$/.test(pageSlug) || pageSlug === '') g = `1 sentence. Short punchy tagline for free-to-play social gaming on ${brand}. Max 12 words.${isSocial ? ' NO banned words.' : ''}`;
      else if (/about/.test(pageSlug)) g = `1 sentence about the ${brand} community and who the platform is for. Max 20 words.${isSocial ? ' NO banned words.' : ''}`;
      else if (/game/.test(pageSlug)) g = `1 sentence inviting players to explore the ${brand} games library. Max 20 words.${isSocial ? ' NO banned words.' : ''}`;
      else if (/contact/.test(pageSlug)) g = `1 welcoming sentence inviting players to reach out to ${brand}. Max 20 words.${isSocial ? ' NO banned words.' : ''}`;
      else g = `1 sentence. On-brand tagline for ${brand}. Max 20 words.${isSocial ? ' NO banned words.' : ''}`;
    }
    else if (k.includes('hero_sub') || k.includes('hero_desc') || k.includes('hero_text')) g = '1 sentence. Max 20 words. Benefit-focused.';
    else if (/feature_\d+_title/.test(k)) g = isSocial ? '2-4 words. BANNED: jackpot, bonus, daily, rewards, casino, gambling. Use ONLY from: Instant Play, Free Games, Safe Community, Browser Fun, Play Anywhere, No Downloads.' : '2-4 words. Key benefit.';
    else if (/feature_\d+_text/.test(k)) g = isSocial ? '1 sentence. Max 15 words. BANNED: jackpot, bonus, daily, rewards, casino, gambling.' : '1 sentence. Max 15 words.';
    else if ((k.includes('feature') || k.includes('card')) && (k.includes('title') || k.includes('heading'))) g = isSocial ? '2-4 words. BANNED: jackpot, bonus, daily, rewards. Use ONLY from: Instant Play, Free Games, Safe Community, Browser Fun, Play Anywhere, No Downloads.' : '2-4 words. Key benefit.';
    else if ((k.includes('feature') || k.includes('card')) && (k.includes('desc') || k.includes('text') || k.includes('content'))) g = isSocial ? '1 sentence. Max 15 words. BANNED: jackpot, bonus, daily, rewards.' : '1 sentence. Max 15 words.';
    else if (k.includes('about') && (k.includes('content') || k.includes('text') || k.includes('body'))) g = `MINIMUM 700 words of body text. Output as HTML using <h2> subheadings and <p> paragraph tags — NO markdown. 5-6 paragraphs minimum. Each paragraph at least 3-4 sentences. Cover: who we are, mission, games/content, community values, why users love the platform. ${isSocial ? 'This is a FREE-TO-PLAY social gaming platform. Cover: what the platform is, the games available, the community, why it is fun and accessible. No real money, no gambling. Mention free-to-play nature and 21+ entertainment only.' : 'Include brand positioning and key benefits.'}`;
    else if (k.includes('about') && (k.includes('title') || k.includes('heading'))) g = 'Max 6 words.';
    else if (k.includes('privacy') && (k.includes('content') || k.includes('body') || k.includes('text'))) g = `MINIMUM 300 words. Section headings. Cover: data collected, how used, cookies, third parties, data retention, user rights, contact (privacy@${brand.toLowerCase().replace(/\s+/g, '')}.com).`;
    else if (k.includes('terms') && (k.includes('content') || k.includes('body') || k.includes('text'))) g = `MINIMUM 300 words. Section headings. Cover: eligibility 21+, platform nature (${isSocial ? 'entertainment only, no real money' : 'licensed gaming'}), user conduct, IP, disclaimer, governing law.`;
    else if (k.includes('contact') && (k.includes('content') || k.includes('text'))) g = '2-3 sentences. Friendly contact intro.';
    else if (k.includes('seo') || k.includes('meta_desc') || k.includes('meta_description')) g = 'Max 155 characters. Include brand name.';
    else if (k.includes('tagline') || k.includes('slogan')) g = 'Max 8 words. Memorable.';
    else if (k.includes('submit')) g = 'Maximum 4 words. It is a button label — short action phrase only.';
    else if (k.includes('button') || k.includes('btn') || k.includes('label') || k.includes('cta')) g = '2-6 words maximum. Action-oriented.';
    else if (k.includes('checkbox_text') || k.includes('privacy_text')) g = 'One sentence maximum. Under 20 words.';
    else if (key === '_post_content' && /about/i.test(pageSlug)) g = `MINIMUM 700 words of body text. Plain paragraphs only — no markdown. 5-6 paragraphs minimum. Each paragraph at least 3-4 sentences. Cover: who we are, mission, games/content, community values, why users love the platform. ${isSocial ? 'FREE-TO-PLAY social gaming platform. No real money, no gambling. Mention free-to-play nature and 21+ entertainment only.' : 'Include brand positioning and key benefits.'}`;
    else if (key === '_post_content' && /terms|privacy|responsible|jogo|termos|privacidade|conditions/i.test(pageSlug)) g = 'MINIMUM 400 words. Plain paragraphs only — no markdown. Structure sections using plain text like "1. SECTION TITLE" on its own line followed by the paragraph. No bold, no headers.';
    else if (k.includes('subtitle')) g = `1-2 sentences. On-brand description. ${isSocial ? 'Social gaming tone. NO banned words.' : 'Informative, benefit-focused.'}`;
    else if (k.includes('announcement') || k.includes('announcement_bar') || k.includes('bar_text')) g = `One sentence. 21+ adult audience, amusement only, no real money, no prizes. Rephrase uniquely for ${brand}. Max 20 words.`;
    else g = `Concise, on-brand. ${isSocial ? 'NO banned words.' : ''}`;
    return `"${key}": ${g}${value ? ` [current: "${String(value).slice(0, 50)}"]` : ''}`;
  }).join('\n');

  return `${ctx}

RULES:
- Never use markdown formatting like **bold** or ## headers in any field value. For post_content fields, use plain paragraphs separated by double newlines. For heading structure use plain text with a newline, not markdown.
- If the original field value is short (under 60 characters), your replacement must also be short — under 60 characters.
- Every piece of content must be 100% unique to "${brand}". Do not reuse sentences, phrases, or structures that could apply to any other brand. Write as if this content exists only for "${brand}" — specific voice, specific personality, no generic filler.
${isSocial ? `- BANNED WORDS (every field, no exceptions): casino, gambling, betting, wager, real money, deposit, withdrawal, odds, slots, payout, bonus, bonuses, rewards, jackpot, wins, prize, win. Use instead: free games, instant play, browser games, social gaming, community, fun, entertainment, free-to-play.` : ""}
Write content for ALL fields below for "${brand}" (page/section: ${pageSlug || 'global'}).
Return ONLY a valid JSON object — no markdown, no explanation.

FIELDS:
${fieldGuides}

JSON format: { "field_key": "content", ... }`;
}

function buildRepeaterPrompt(fieldKey, brand, siteType, rowCount) {
  const ctx = sysCtx(brand, siteType);
  const isSocial = siteType === 'social-en';

  if (fieldKey.includes('testimonial')) {
    const names = ['Ayla T', 'Remi K', 'Kian S', 'Noor J', 'Teo M', 'Mira L', 'Joss P', 'Leif R', 'Zara W', 'Suki B'].slice(0, rowCount).join(', ');
    return `${ctx}
Generate exactly ${rowCount} unique testimonials as a JSON array for "${brand}".
Rules:
- author_name must use these names in order: ${names}. Do not invent other names.
- Each testimonial_text must be completely different from every other — different angle, different wording, different sentence structure.
- First person. 2-3 sentences each. Do NOT mention the brand name inside the text.
${isSocial ? '- Topic: the free social gaming experience — free games, browser play, community, fun. Zero casino/gambling/money words.' : '- Topic: finding useful casino review information on the site.'}
- No two testimonials can sound alike.
Return ONLY a valid JSON array with exactly ${rowCount} objects:
[{"author_name":"...","testimonial_text":"..."},...]`;
  }

  if (fieldKey.includes('faq')) {
    const socialTopics = 'is it free to play, do I need to download anything, how do virtual credits work, is there an age limit, can I play on mobile';
    const casinoTopics = 'are the reviews independent, how do you rate casinos, is this site free to use';
    return `${ctx}
Generate exactly ${rowCount} FAQ entries as a JSON array for "${brand}".
Rules:
- Each entry must have a unique question and a unique answer.
- Questions must cover different topics — do not repeat any question.
- Topics to use in order: ${isSocial ? socialTopics : casinoTopics}.
- Tailor every answer specifically to the "${brand}" brand. 1-2 sentences per answer.
${isSocial ? '- No casino/gambling/money words in any answer.' : ''}
- No two questions or answers can be the same.
Return ONLY a valid JSON array with exactly ${rowCount} objects:
[{"question":"...","answer":"..."},...]`;
  }

  if (fieldKey.includes('leaderboard') || fieldKey.includes('leader_board') || fieldKey.includes('top_players') || fieldKey.includes('scoreboard') || fieldKey.includes('score_board')) {
    const players = ['GalaxySpinner', 'NeonDrifter', 'PixelAce', 'CosmicReel', 'StarChaser', 'LunarAce', 'VoidRunner'].slice(0, rowCount).join(', ');
    return `${ctx}
Generate exactly ${rowCount} leaderboard rows as a JSON array for "${brand}".
Rules:
- player names must use these in order: ${players}. Do not repeat any name.
- rank starts at 1 and increments by 1.
- score must start at a random number between 40000 and 95000 and decrease by a random amount (between 5000 and 12000) for each subsequent row. No two scores the same.
Return ONLY a valid JSON array with exactly ${rowCount} objects:
[{"rank":"1","player":"...","score":"..."},...]`;
  }

  return `${ctx}\nGenerate exactly ${rowCount} unique rows for the "${fieldKey}" repeater field for "${brand}". Each row must be different. Return ONLY a valid JSON array of objects.`;
}

async function callAI(apiKey, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text?.trim() || '';
}

async function wpFetch(wpUrl, auth, endpoint, method = 'GET', body) {
  const url = wpUrl.replace(/\/$/, '') + endpoint;
  const opts = {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(auth).toString('base64'),
      'Content-Type': 'application/json'
    }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { _fetchError: `non-JSON (HTTP ${r.status})`, raw: text.slice(0, 300) }; }
  } catch(e) {
    return { _fetchError: e.message };
  }
}

async function fetchCPTSlugs(wpUrl, auth) {
  try {
    const types = await wpFetch(wpUrl, auth, '/wp-json/wp/v2/types');
    if (!types || types._fetchError || types.code) return [];
    return Object.values(types)
      .filter(t => t.rest_base && !BUILT_IN_TYPES.has(t.slug))
      .map(t => t.rest_base);
  } catch { return []; }
}

// ============================================================
// /api/run — SSE streaming endpoint
// ============================================================
app.post('/api/run', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.apiKey) { res.status(400).json({ error: 'No API key saved.' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { wpUrl, auth, brandName, siteType, scope = 'all', force = false, skipRepeaters = false } = req.body;
  let stopped = false;
  req.on('close', () => { setTimeout(() => { stopped = true; }, 5000); });

  const emit = (msg, type = 'info') => res.write(`data: ${JSON.stringify({ msg, type })}\n\n`);
  const finish = (msg) => { res.write(`data: ${JSON.stringify({ msg, type: 'done' })}\n\n`); res.end(); };
  const fatal = (msg) => { res.write(`data: ${JSON.stringify({ msg, type: 'error' })}\n\n`); res.end(); };

  if (!wpUrl || !brandName) { fatal('Missing wpUrl or brandName'); return; }

  const t0 = Date.now();
  emit(`▶ ${brandName} · scope: ${scope}${force ? ' · Force ON' : ''}`, 'head');

  try {
    // ---- 1. DISCOVER ----
    emit('Discovering site structure...');

    const [globalData, pages, posts, cptSlugs] = await Promise.all([
      (scope === 'all' || scope === 'globals' || scope === 'repeaters')
        ? wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/fields')
        : Promise.resolve({}),
      (scope === 'all' || scope === 'pages')
        ? wpFetch(wpUrl, auth, '/wp-json/wp/v2/pages?per_page=100&_fields=id,title,slug,acf,content')
        : Promise.resolve([]),
      (scope === 'all' || scope === 'pages')
        ? wpFetch(wpUrl, auth, '/wp-json/wp/v2/posts?per_page=50&_fields=id,title,slug,acf,content')
        : Promise.resolve([]),
      (scope === 'all' || scope === 'pages')
        ? fetchCPTSlugs(wpUrl, auth)
        : Promise.resolve([])
    ]);

    // Detect failure: network error (_fetchError), WP REST error (code+message), or non-object
    const globalFailed = !globalData || globalData._fetchError || globalData.code;
    const safeGlobal = (!globalFailed && typeof globalData === 'object' && !Array.isArray(globalData)) ? globalData : {};
    if (globalFailed) {
      emit(`Global options fetch failed: ${globalData?._fetchError || globalData?.message || globalData?.code || 'unknown error'}`, 'warn');
    }

    const safePages = Array.isArray(pages) ? pages : [];
    const safePosts = Array.isArray(posts) ? posts : [];

    const totalStringFields = Object.values(safeGlobal).filter(v => typeof v === 'string').length;
    const totalRepeaters = Object.values(safeGlobal).filter(v => Array.isArray(v)).length;
    emit(`Options: ${Object.keys(safeGlobal).length} fields (${totalStringFields} text, ${totalRepeaters} repeaters) · Pages: ${safePages.length} · Posts: ${safePosts.length} · CPTs: ${cptSlugs.length}`, 'ok');
    if (stopped) { emit('Stopped.', 'warn'); res.end(); return; }

    // Fetch CPT items
    const cptItems = [];
    for (const slug of cptSlugs) {
      if (stopped) break;
      try {
        const items = await wpFetch(wpUrl, auth, `/wp-json/wp/v2/${slug}?per_page=50&_fields=id,title,slug,acf,content`);
        if (Array.isArray(items) && items.length) {
          emit(`CPT "${slug}": ${items.length} items`, 'ok');
          items.forEach(p => cptItems.push({ ...p, _restBase: slug }));
        }
      } catch {}
    }

    const tasks = [];

    // ---- 2. GLOBAL OPTIONS ----
    if ((scope === 'all' || scope === 'globals') && Object.keys(safeGlobal).length) {
      const textFields = [];
      const repeaterFields = [];

      for (const [key, value] of Object.entries(safeGlobal)) {
        if (Array.isArray(value)) {
          repeaterFields.push({ key, rows: value });
        } else if (typeof value === 'string') {
          // Always rewrite all string fields — that's what the tool is for.
          // Skip only obvious non-content values (empty, pure numbers, image URLs, short codes).
          if (value.trim().length > 0 && !/^https?:\/\/\S+\.(png|jpg|jpeg|gif|svg|webp)/i.test(value.trim())) {
            textFields.push({ key, value });
          }
        }
      }

      if (textFields.length) {
        tasks.push((async () => {
          emit(`Globals: ${textFields.length} text fields — 1 AI call...`);
          try {
            const raw = await callAI(cfg.apiKey, buildBatchPrompt(textFields, brandName, siteType, 'global'));
            const updates = parseJSON(raw);
            await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', updates);
            emit(`✓ Globals: ${Object.keys(updates).length} fields written`, 'ok');
          } catch(e) {
            emit(`Globals batch failed (${e.message}) — field-by-field fallback`, 'warn');
            const fallback = {};
            for (const f of textFields) {
              if (stopped) break;
              try {
                const raw = await callAI(cfg.apiKey, buildBatchPrompt([f], brandName, siteType, 'global'));
                const p = parseJSON(raw);
                fallback[f.key] = p[f.key] || Object.values(p)[0] || '';
                emit(`  ↳ ${f.key}: written`, 'ok');
              } catch(e2) { emit(`  ↳ ${f.key}: failed — ${e2.message}`, 'err'); }
            }
            if (Object.keys(fallback).length) {
              await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', fallback);
            }
          }
        })());
      } else {
        emit('Globals: all clean, skipping', 'skip');
      }

      // Repeaters
      if (!skipRepeaters && (scope === 'all' || scope === 'repeaters')) {
        for (const { key, rows } of repeaterFields) {
          if (stopped) break;
          const rowCount = rows.length || 3;
          console.log(`[REPEATER] key="${key}" rowCount=${rowCount}`);
          tasks.push((async () => {
            emit(`Repeater: ${key} (${rowCount} rows)...`);
            try {
              // Single AI call returns all rows at once
              const raw = await callAI(cfg.apiKey, buildRepeaterPrompt(key, brandName, siteType, rowCount));
              console.log(`[REPEATER AI RAW] key="${key}":`, raw.slice(0, 600));
              const newRows = parseJSONArray(raw);
              console.log(`[REPEATER WRITE] key="${key}" rows:`, JSON.stringify(newRows));
              // Bulk write via the same update endpoint used for text fields
              const wpRes = await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', { [key]: newRows });
              console.log(`[REPEATER RESULT] key="${key}":`, JSON.stringify(wpRes));
              if (wpRes && wpRes._fetchError) {
                emit(`${key}: bulk write failed, trying row-by-row...`, 'warn');
                await Promise.all(newRows.map((row, i) =>
                  wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/repeater', 'POST', { field: key, row: i, data: row })
                ));
              }
              emit(`✓ ${key}: ${newRows.length} rows written`, 'ok');
            } catch(e) {
              console.log(`[REPEATER ERROR] key="${key}": ${e.message}`);
              emit(`${key} repeater error: ${e.message}`, 'err');
            }
          })());
        }
      }
    }

    // ---- 3. PAGES / POSTS / CPTs ----
    if (scope === 'all' || scope === 'pages') {
      const allItems = [
        ...safePages.map(p => ({ ...p, _restBase: 'pages' })),
        ...safePosts.map(p => ({ ...p, _restBase: 'posts' })),
        ...cptItems
      ];

      if (allItems.length) {
        emit(`Processing ${allItems.length} pages/posts in parallel...`);

        for (const item of allItems) {
          if (stopped) break;
          tasks.push((async () => {
            const restBase = item._restBase || 'pages';
            const pageSlug = item.slug || '';
            const title = item.title?.rendered || pageSlug;
            const acf = item.acf || {};

            // ACF fields, post title, and post content
            const rawContent = (item.content?.rendered || '').replace(/<[^>]+>/g, '').trim();

            const fieldsToWrite = [
              ...(rawContent.length > 30 ? [{ key: '_post_content', value: rawContent.substring(0, 800) }] : []),
              ...Object.entries(acf)
                .filter(([k, v]) => {
                  console.log(`[ACF FILTER] page="${pageSlug}" key="${k}" type=${typeof v} value=${JSON.stringify(typeof v === 'string' ? v.slice(0, 80) : v)}`);
                  const hasLoremIpsum = typeof v === 'string' && /lorem ipsum/i.test(v.trim());
                  if (hasLoremIpsum) { console.log(`[LOREM OVERRIDE] key="${k}" forced in`); return true; }
                  if (v === false || v === null) return true; // ACF field exists but never saved
                  return typeof v === 'string' && v.trim().length > 0 && !/^https?:\/\/\S+\.(png|jpg|jpeg|gif|svg|webp)/i.test(v.trim());
                })
                .map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : '' }))
            ];

            if (fieldsToWrite.length <= 2 && !rawContent.length) { emit(`${title}: no fields to rewrite, skip`, 'skip'); return; }

            emit(`${title}: ${fieldsToWrite.length} fields — 1 AI call...`);
            try {
              const raw = await callAI(cfg.apiKey, buildBatchPrompt(fieldsToWrite, brandName, siteType, pageSlug));
              const updates = parseJSON(raw);
              const postUpdate = { acf: {} };
              for (const [k, v] of Object.entries(updates)) {
                if (k === '_post_content') postUpdate.content = v;
                else postUpdate.acf[k] = v;
              }
              if (!Object.keys(postUpdate.acf).length) delete postUpdate.acf;
              await wpFetch(wpUrl, auth, `/wp-json/wp/v2/${restBase}/${item.id}`, 'POST', postUpdate);
              emit(`✓ ${title}: written`, 'ok');
            } catch(e) {
              emit(`${title} failed: ${e.message}`, 'err');
            }
          })());
        }
      }
    }

    // ---- 4. RUN ALL IN PARALLEL ----
    emit(`Firing ${tasks.length} tasks in parallel...`, 'head');
    await Promise.all(tasks);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    finish(`🎉 Done in ${elapsed}s — check the site.`);

  } catch(e) {
    fatal(`Fatal: ${e.message}`);
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = 3000;
app.listen(PORT, () => console.log(`\n  ⚡ Content Dashboard running at http://localhost:${PORT}\n`));
