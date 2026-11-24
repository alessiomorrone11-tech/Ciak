/* Ciak · server di ricerca (Cloudflare Worker)
   Fa da tramite tra l'app e i servizi esterni, così le chiavi restano qui e non nel browser.
   Variabili da impostare su Cloudflare (Settings → Variables and Secrets):
     BRAVE_KEY        (segreto)   chiave Brave Search API
     YT_KEY           (segreto, facoltativa) chiave YouTube Data API v3
     ALLOWED_ORIGINS  (testo)     indirizzi dell'app autorizzati, separati da virgola, es. https://tuonome.github.io
*/
const TTL = 6 * 3600;            // cache: 6 ore
const MAX_Q = 200;

function origins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const ok = origins(env).includes(o);
  return { ok, h: ok ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : {} };
}
function json(obj, status, h) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, h || {}) });
}
function clean(q) { return String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q); }

async function cached(req, ctx, key, make) {
  const cache = caches.default, ck = new Request('https://cache.ciak.local/' + encodeURIComponent(key));
  const hit = await cache.match(ck);
  if (hit) return hit.json();
  const data = await make();
  const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + TTL } });
  ctx.waitUntil(cache.put(ck, res));
  return data;
}

async function web(q, env) {
  if (!env.BRAVE_KEY) throw Object.assign(new Error('brave-non-configurato'), { status: 503 });
  const u = 'https://api.search.brave.com/res/v1/web/search?count=8&country=IT&search_lang=it&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_KEY } });
  if (!r.ok) throw Object.assign(new Error('brave-' + r.status), { status: r.status === 429 ? 429 : 502 });
  const j = await r.json();
  return { results: ((j.web && j.web.results) || []).map(x => ({ title: x.title, url: x.url, description: String(x.description || '').replace(/<[^>]+>/g, ''), age: x.age || '' })) };
}

async function yt(q, env, minutes) {
  if (!env.YT_KEY) throw Object.assign(new Error('yt-non-configurato'), { status: 503 });
  const d = minutes && minutes < 4 ? 'short' : 'medium';
  const s = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&order=viewCount&videoDuration=' + d + '&q=' + encodeURIComponent(q) + '&key=' + env.YT_KEY);
  if (!s.ok) throw Object.assign(new Error('youtube-' + s.status), { status: 502 });
  const sj = await s.json(), ids = (sj.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return { results: [] };
  const v = await fetch('https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=' + ids.join(',') + '&key=' + env.YT_KEY);
  const vj = await v.json();
  return { results: (vj.items || []).map(x => { const st = x.statistics || {}; return { id: x.id, t: x.snippet.title, ch: x.snippet.channelTitle, v: +st.viewCount || 0, l: +st.likeCount || 0, c: +st.commentCount || 0 }; }).sort((a, b) => b.v - a.v) };
}

/* lettura di una pagina pubblica (es. regolamento o palmarès di un festival): solo https, niente indirizzi interni */
function safeUrl(s) {
  let u; try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  return u;
}
async function page(raw) {
  const u = safeUrl(raw);
  if (!u) throw Object.assign(new Error('indirizzo-non-valido'), { status: 400 });
  const r = await fetch(u.href, { redirect: 'manual', headers: { 'User-Agent': 'CiakBot/1.0', 'Accept': 'text/html' } });
  if (r.status >= 300 && r.status < 400) {
    const loc = safeUrl(new URL(r.headers.get('Location') || '', u).href);
    if (!loc) throw Object.assign(new Error('reindirizzamento-non-consentito'), { status: 400 });
    const r2 = await fetch(loc.href, { redirect: 'manual', headers: { 'User-Agent': 'CiakBot/1.0', 'Accept': 'text/html' } });
    return extract(r2, loc.href);
  }
  return extract(r, u.href);
}
async function extract(r, url) {
  if (!r.ok) throw Object.assign(new Error('pagina-' + r.status), { status: 502 });
  if (!/text\/html|text\/plain/i.test(r.headers.get('Content-Type') || '')) throw Object.assign(new Error('tipo-non-supportato'), { status: 415 });
  const html = (await r.text()).slice(0, 400000);
  const title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 2500);
  return { url, title, text };
}

export default {
  async fetch(req, env, ctx) {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.h });
    if (req.method !== 'GET') return json({ error: 'metodo-non-consentito' }, 405, c.h);
    if (!c.ok) return json({ error: 'origine-non-autorizzata' }, 403);
    const u = new URL(req.url), p = u.pathname.replace(/\/+$/, '');
    try {
      if (p === '/api/ping') return json({ ok: true, brave: !!env.BRAVE_KEY, youtube: !!env.YT_KEY }, 200, c.h);
      if (p === '/api/web') {
        const q = clean(u.searchParams.get('q')); if (q.length < 3) return json({ error: 'ricerca-troppo-corta' }, 400, c.h);
        return json(await cached(req, ctx, 'web|' + q.toLowerCase(), () => web(q, env)), 200, c.h);
      }
      if (p === '/api/yt') {
        const q = clean(u.searchParams.get('q')), m = Math.min(300, Math.max(0, +u.searchParams.get('min') || 0)); if (q.length < 3) return json({ error: 'ricerca-troppo-corta' }, 400, c.h);
        return json(await cached(req, ctx, 'yt|' + m + '|' + q.toLowerCase(), () => yt(q, env, m)), 200, c.h);
      }
      if (p === '/api/page') {
        const raw = u.searchParams.get('url') || ''; if (!safeUrl(raw)) return json({ error: 'indirizzo-non-valido' }, 400, c.h);
        return json(await cached(req, ctx, 'page|' + raw, () => page(raw)), 200, c.h);
      }
      return json({ error: 'non-trovato' }, 404, c.h);
    } catch (e) {
      return json({ error: e.message || 'errore' }, e.status || 500, c.h);
    }
  }
};

export { safeUrl };
