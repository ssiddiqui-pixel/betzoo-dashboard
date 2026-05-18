import { loadConfig } from '../_lib/config.js';
import {
  parseJSON, parseJSONArray,
  buildBatchPrompt, buildRepeaterPrompt,
  callAI, wpFetch, fetchCPTSlugs
} from '../_lib/prompts.js';

// POST /api/run -> SSE stream of progress events.
// Mirrors server.js /api/run end-to-end: discover -> globals -> repeaters -> pages/posts/CPTs.
export async function onRequestPost({ request, env }) {
  const cfg = await loadConfig(env);
  if (!cfg.apiKey) {
    return Response.json({ error: 'No API key saved.' }, { status: 400 });
  }

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { wpUrl, auth, brandName, siteType, scope = 'all', force = false, skipRepeaters = false } = body;
  if (!wpUrl || !brandName) {
    return Response.json({ error: 'Missing wpUrl or brandName' }, { status: 400 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const write = async (payload) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    } catch {
      closed = true;
    }
  };
  const emit = (msg, type = 'info') => write({ msg, type });
  const finish = async (msg) => {
    await write({ msg, type: 'done' });
    closed = true;
    try { await writer.close(); } catch {}
  };
  const fatal = async (msg) => {
    await write({ msg, type: 'error' });
    closed = true;
    try { await writer.close(); } catch {}
  };

  // Kick off the work; the streaming response keeps the connection alive.
  (async () => {
    const t0 = Date.now();
    await emit(`▶ ${brandName} · scope: ${scope}${force ? ' · Force ON' : ''}`, 'head');

    try {
      // ---- 1. DISCOVER ----
      await emit('Discovering site structure...');

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

      const globalFailed = !globalData || globalData._fetchError || globalData.code;
      const safeGlobal = (!globalFailed && typeof globalData === 'object' && !Array.isArray(globalData)) ? globalData : {};
      if (globalFailed) {
        await emit(`Global options fetch failed: ${globalData?._fetchError || globalData?.message || globalData?.code || 'unknown error'}`, 'warn');
      }

      const safePages = Array.isArray(pages) ? pages : [];
      const safePosts = Array.isArray(posts) ? posts : [];

      const totalStringFields = Object.values(safeGlobal).filter(v => typeof v === 'string').length;
      const totalRepeaters = Object.values(safeGlobal).filter(v => Array.isArray(v)).length;
      await emit(`Options: ${Object.keys(safeGlobal).length} fields (${totalStringFields} text, ${totalRepeaters} repeaters) · Pages: ${safePages.length} · Posts: ${safePosts.length} · CPTs: ${cptSlugs.length}`, 'ok');

      // Fetch CPT items
      const cptItems = [];
      for (const slug of cptSlugs) {
        try {
          const items = await wpFetch(wpUrl, auth, `/wp-json/wp/v2/${slug}?per_page=50&_fields=id,title,slug,acf,content`);
          if (Array.isArray(items) && items.length) {
            await emit(`CPT "${slug}": ${items.length} items`, 'ok');
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
            if (value.trim().length > 0 && !/^https?:\/\/\S+\.(png|jpg|jpeg|gif|svg|webp)/i.test(value.trim())) {
              textFields.push({ key, value });
            }
          }
        }

        if (textFields.length) {
          tasks.push((async () => {
            await emit(`Globals: ${textFields.length} text fields — 1 AI call...`);
            try {
              const raw = await callAI(cfg.apiKey, buildBatchPrompt(textFields, brandName, siteType, 'global'));
              const updates = parseJSON(raw);
              await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', updates);
              await emit(`✓ Globals: ${Object.keys(updates).length} fields written`, 'ok');
            } catch (e) {
              await emit(`Globals batch failed (${e.message}) — field-by-field fallback`, 'warn');
              const fallback = {};
              for (const f of textFields) {
                try {
                  const raw = await callAI(cfg.apiKey, buildBatchPrompt([f], brandName, siteType, 'global'));
                  const p = parseJSON(raw);
                  fallback[f.key] = p[f.key] || Object.values(p)[0] || '';
                  await emit(`  ↳ ${f.key}: written`, 'ok');
                } catch (e2) {
                  await emit(`  ↳ ${f.key}: failed — ${e2.message}`, 'err');
                }
              }
              if (Object.keys(fallback).length) {
                await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', fallback);
              }
            }
          })());
        } else {
          await emit('Globals: all clean, skipping', 'skip');
        }

        // Repeaters
        if (!skipRepeaters && (scope === 'all' || scope === 'repeaters')) {
          for (const { key, rows } of repeaterFields) {
            const rowCount = rows.length || 3;
            tasks.push((async () => {
              await emit(`Repeater: ${key} (${rowCount} rows)...`);
              try {
                const raw = await callAI(cfg.apiKey, buildRepeaterPrompt(key, brandName, siteType, rowCount));
                const newRows = parseJSONArray(raw);
                const wpRes = await wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/update', 'POST', { [key]: newRows });
                if (wpRes && wpRes._fetchError) {
                  await emit(`${key}: bulk write failed, trying row-by-row...`, 'warn');
                  await Promise.all(newRows.map((row, i) =>
                    wpFetch(wpUrl, auth, '/wp-json/acf-options/v1/repeater', 'POST', { field: key, row: i, data: row })
                  ));
                }
                await emit(`✓ ${key}: ${newRows.length} rows written`, 'ok');
              } catch (e) {
                await emit(`${key} repeater error: ${e.message}`, 'err');
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
          await emit(`Processing ${allItems.length} pages/posts in parallel...`);

          for (const item of allItems) {
            tasks.push((async () => {
              const restBase = item._restBase || 'pages';
              const pageSlug = item.slug || '';
              const title = item.title?.rendered || pageSlug;
              const acf = item.acf || {};

              const rawContent = (item.content?.rendered || '').replace(/<[^>]+>/g, '').trim();

              const fieldsToWrite = [
                ...(rawContent.length > 30 ? [{ key: '_post_content', value: rawContent.substring(0, 800) }] : []),
                ...Object.entries(acf)
                  .filter(([k, v]) => {
                    const hasLoremIpsum = typeof v === 'string' && /lorem ipsum/i.test(v.trim());
                    if (hasLoremIpsum) return true;
                    if (v === false || v === null) return true; // ACF field exists but never saved
                    return typeof v === 'string' && v.trim().length > 0 && !/^https?:\/\/\S+\.(png|jpg|jpeg|gif|svg|webp)/i.test(v.trim());
                  })
                  .map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : '' }))
              ];

              if (fieldsToWrite.length <= 2 && !rawContent.length) {
                await emit(`${title}: no fields to rewrite, skip`, 'skip');
                return;
              }

              await emit(`${title}: ${fieldsToWrite.length} fields — 1 AI call...`);
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
                await emit(`✓ ${title}: written`, 'ok');
              } catch (e) {
                await emit(`${title} failed: ${e.message}`, 'err');
              }
            })());
          }
        }
      }

      // ---- 4. RUN ALL IN PARALLEL ----
      await emit(`Firing ${tasks.length} tasks in parallel...`, 'head');
      await Promise.all(tasks);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      await finish(`🎉 Done in ${elapsed}s — check the site.`);
    } catch (e) {
      await fatal(`Fatal: ${e.message}`);
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
