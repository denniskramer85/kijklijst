#!/usr/bin/env node
// Kijklijst-synchronisatie. Draait dagelijks in GitHub Actions (Node 22+, geen afhankelijkheden).
//
// 1. Leest je openbare IMDb-watchlist en je beoordelingen via het GraphQL-adres dat imdb.com zelf gebruikt.
// 2. Zoekt elke titel op bij TMDB en haalt daar details en het streamingaanbod (JustWatch) op.
// 3. Stelt tips samen uit titels die verwant zijn aan wat je hoog beoordeelde en wat op je lijst staat.
// 4. Schrijft site/data/data.json (wat de app toont) en cache/cache.json (om TMDB niet onnodig te bevragen).
//
// Van IMDb worden alleen titel-id's, titels, jaartallen en je eigen cijfers overgenomen; al het andere komt van TMDB.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMDB_URL = process.env.IMDB_GRAPHQL_URL || "https://api.graphql.imdb.com/";
const TMDB_URL = (process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3").replace(/\/$/, "");
const KEY = (process.env.TMDB_API_KEY || "").trim();
const DAY = 864e5;
const now = Date.now();

const warnings = [];
const warn = m => { warnings.push(m); console.log("::warning::" + m); };
const log = m => console.log(m);
const fail = m => { console.error("::error::" + m); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniq = a => [...new Set(a)];
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
const round1 = n => Math.round((+n || 0) * 10) / 10;

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(ROOT, file), "utf8")); } catch { return fallback; }
}
async function writeJson(file, value, indent) {
  const full = path.join(ROOT, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value, null, indent) + "\n");
}

/* ------------------------------------------------------------------ IMDb */
const IMDB_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "x-imdb-client-name": "imdb-web-next",
  "x-imdb-user-country": "US",
  "x-imdb-user-language": "en-US",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
};
async function imdb(query) {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try { res = await fetch(IMDB_URL, { method: "POST", headers: IMDB_HEADERS, body: JSON.stringify({ query }) }); }
    catch (e) { last = e.message; await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { last = "HTTP " + res.status; await sleep(3000 * (attempt + 1)); continue; }
    try { return await res.json(); }
    catch { throw new Error(`IMDb gaf een onleesbaar antwoord (HTTP ${res.status}).`); }
  }
  throw new Error("IMDb is niet bereikbaar of weigert de aanvraag (" + last + ").");
}
const gqlErrors = b => ((b && b.errors) || []).map(e => [e.message, e.extensions && e.extensions.code].filter(Boolean).join(" ")).join("; ");
const mapTitle = t => ({
  imdb: t.id,
  title: (t.titleText && t.titleText.text) || "",
  orig: (t.originalTitleText && t.originalTitleText.text) || "",
  type: (t.titleType && t.titleType.id) || "",
  year: (t.releaseYear && t.releaseYear.year) || 0
});
const kindOf = type => { const s = String(type || "").toLowerCase(); return s.includes("episode") ? "episode" : s.includes("series") ? "tv" : /game|podcast|music/.test(s) ? "other" : "movie"; };

function parseUser(input) {
  const s = String(input || "");
  const m = s.match(/ur\d{5,12}/) || s.match(/p\.[a-z0-9]{10,40}/i);
  return m ? m[0] : null;
}
async function resolveUser(id, cache) {
  if (id.startsWith("ur")) return { ur: id, nick: (cache.user[id] && cache.user[id].nick) || "" };
  if (cache.user[id]) return cache.user[id];
  const b = await imdb(`query { userProfile(input: { profileId: ${JSON.stringify(id)} }) { userId nickName } }`);
  const p = b && b.data && b.data.userProfile;
  if (!p || !p.userId) throw new Error("IMDb kent dit profiel niet (" + id + "): " + (gqlErrors(b) || "geen gegevens"));
  return (cache.user[id] = { ur: p.userId, nick: p.nickName || "" });
}

async function fetchWatchlist(ur) {
  const items = []; let after = null, total = null;
  for (let page = 0; page < 40; page++) {
    const args = ["first: 250", "sort: { by: LIST_ORDER, order: ASC }", ...(after ? ["after: " + JSON.stringify(after)] : [])].join(", ");
    const b = await imdb(`query { list: predefinedList(classType: WATCH_LIST, userId: ${JSON.stringify(ur)}) { titleListItemSearch(${args}) { total pageInfo { hasNextPage endCursor } edges { title { id titleText { text } originalTitleText { text } titleType { id } releaseYear { year } } } } } }`);
    const s = b && b.data && b.data.list && b.data.list.titleListItemSearch;
    if (!s) {
      const err = gqlErrors(b);
      if ((b && b.data && !b.data.list) || /not.?found|forbidden|permission|private/i.test(err))
        throw new Error("IMDb geeft je watchlist niet vrij. Zet hem in de privacy-instellingen van je watchlist op IMDb op openbaar en start de taak opnieuw." + (err ? " Melding van IMDb: " + err : ""));
      throw new Error("IMDb gaf geen watchlist terug: " + (err || "onbekende reden"));
    }
    if (typeof s.total === "number") total = s.total;
    for (const e of s.edges || []) if (e && e.title && e.title.id) items.push(mapTitle(e.title));
    if (!s.pageInfo || !s.pageInfo.hasNextPage || !s.pageInfo.endCursor) break;
    after = s.pageInfo.endCursor;
  }
  if (total != null && items.length < total) warn(`IMDb meldt ${total} titels op je watchlist, maar gaf er ${items.length} terug.`);
  return items;
}

async function fetchRatings(ur) {
  const toRow = n => n && n.title && n.title.id && n.userRating ? { ...mapTitle(n.title), rating: n.userRating.value || 0, rated: String(n.userRating.date || "").slice(0, 10), episode: !!(n.title.titleType && n.title.titleType.isEpisode) } : null;
  const rows = []; let after = null, total = null;
  for (let page = 0; page < 60; page++) {
    const args = ["userId: " + JSON.stringify(ur), "first: 250", ...(after ? ["after: " + JSON.stringify(after)] : [])].join(", ");
    const b = await imdb(`query { userRatings(${args}) { total pageInfo { hasNextPage endCursor } edges { node { userRating { value date } title { id titleText { text } originalTitleText { text } titleType { id isEpisode } releaseYear { year } } } } } }`);
    const r = b && b.data && b.data.userRatings;
    if (!r) {
      if (page > 0) { warn("IMDb brak het ophalen van je beoordelingen af na " + rows.length + " stuks: " + (gqlErrors(b) || "onbekende reden")); break; }
      // Bladeren wordt niet geaccepteerd: val terug op de eenvoudigste vorm van de vraag.
      const b2 = await imdb(`query { userRatings(userId: ${JSON.stringify(ur)}, first: 250) { total edges { node { userRating { value date } title { id titleText { text } titleType { id isEpisode isSeries } releaseYear { year } } } } } }`);
      const r2 = b2 && b2.data && b2.data.userRatings;
      if (!r2) throw new Error(gqlErrors(b2) || gqlErrors(b) || "geen gegevens");
      const simple = (r2.edges || []).map(e => toRow(e && e.node)).filter(Boolean);
      if (r2.total > simple.length) warn(`Van je ${r2.total} beoordelingen konden er maar ${simple.length} worden opgehaald.`);
      return simple;
    }
    if (typeof r.total === "number") total = r.total;
    for (const e of r.edges || []) { const row = toRow(e && e.node); if (row) rows.push(row); }
    if (!r.pageInfo || !r.pageInfo.hasNextPage || !r.pageInfo.endCursor) break;
    after = r.pageInfo.endCursor;
  }
  if (total != null && rows.length < total) warn(`IMDb meldt ${total} beoordelingen, maar gaf er ${rows.length} terug.`);
  return rows;
}

/* ------------------------------------------------------------------ TMDB */
let nextSlot = 0, tmdbCalls = 0;
const slot = () => { const t = Math.max(Date.now(), nextSlot); nextSlot = t + 40; return sleep(t - Date.now()); };
class Fatal extends Error {}
async function tmdb(p, params = {}) {
  const url = new URL(TMDB_URL + p);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { accept: "application/json" };
  if (KEY.startsWith("eyJ")) headers.Authorization = "Bearer " + KEY; else url.searchParams.set("api_key", KEY);
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await slot(); tmdbCalls++;
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) { last = e.message; await sleep(1500 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { last = "HTTP " + res.status; await sleep(1000 * (+res.headers.get("retry-after") || 2 ** attempt)); continue; }
    if (res.status === 401) throw new Fatal("TMDB weigert de sleutel. Controleer het secret TMDB_API_KEY in de instellingen van je repository.");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("TMDB gaf HTTP " + res.status + " op " + p);
    return res.json();
  }
  throw new Error("TMDB is niet bereikbaar (" + last + ") op " + p);
}
async function pool(items, fn, n = 8) {
  let i = 0, fatal = null, failed = 0;
  const run = async () => {
    while (i < items.length && !fatal) {
      const it = items[i++];
      try { await fn(it); } catch (e) { if (e instanceof Fatal) fatal = e; else { failed++; if (failed <= 3) log("  overgeslagen: " + e.message); } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (fatal) throw fatal;
  return failed;
}

/* ------------------------------------------------------------------ main */
const config = await readJson("config.json", {});
const region = String(config.region || "NL").toUpperCase();
const LANG = config.language || "nl-NL";
const userInput = parseUser(config.imdbUser);
if (!userInput) fail("Vul in config.json bij imdbUser het adres van je IMDb-profiel in (bijvoorbeeld https://www.imdb.com/user/ur12345678/).");
if (!KEY) fail("Het secret TMDB_API_KEY ontbreekt. Voeg het toe onder Settings → Secrets and variables → Actions.");

const cache = Object.assign({ user: {}, find: {}, details: {}, recs: {}, ratings: null }, await readJson("cache/cache.json", {}));
const previous = await readJson("site/data/data.json", null);
const provInfo = Object.assign({}, previous && previous.providers);
const noteProvider = p => { provInfo[p.provider_id] = { name: p.provider_name, logo: p.logo_path || null }; };

let user, watchlist, ratings;
try {
  user = await resolveUser(userInput, cache);
  log(`IMDb-gebruiker ${user.ur}${user.nick ? " (" + user.nick + ")" : ""}`);
  watchlist = await fetchWatchlist(user.ur);
  log(`Watchlist: ${watchlist.length} titels`);
} catch (e) { fail(e.message); }
try {
  ratings = (await fetchRatings(user.ur)).filter(r => !r.episode && r.rating);
  cache.ratings = ratings;
  log(`Beoordelingen: ${ratings.length} titels`);
} catch (e) {
  ratings = cache.ratings || [];
  warn("Je beoordelingen konden niet worden opgehaald (" + e.message + "). " + (ratings.length ? "De vorige lijst van " + ratings.length + " wordt gebruikt." : "Tips houden nu geen rekening met wat je al zag."));
}

const filmOrSeries = x => { const k = kindOf(x.type); return k === "movie" || k === "tv"; };

async function resolve(item) {
  const c = cache.find[item.imdb];
  if (c && (!c.miss || now - c.at < 7 * DAY)) return c;
  const d = await tmdb("/find/" + item.imdb, { external_source: "imdb_id" });
  const mv = d && d.movie_results && d.movie_results[0], tv = d && d.tv_results && d.tv_results[0];
  const first = kindOf(item.type) === "tv" ? [tv && ["tv", tv], mv && ["movie", mv]] : [mv && ["movie", mv], tv && ["tv", tv]];
  const hit = first.find(Boolean);
  return (cache.find[item.imdb] = hit ? { t: hit[0], id: hit[1].id, at: now } : { miss: true, at: now });
}
async function details(t, id) {
  const k = `${t}:${id}`, c = cache.details[k];
  if (c && now - c.at < (25 + id % 10) * DAY) return c;       // gespreid verversen, niet alles op één dag
  const d = await tmdb(`/${t}/${id}`, { language: LANG, append_to_response: "credits,translations" });
  if (!d) return c || null;
  const en = ((d.translations && d.translations.translations) || []).find(x => x.iso_639_1 === "en");
  return (cache.details[k] = {
    at: now,
    title: d.title || d.name || "", orig: d.original_title || d.original_name || "",
    year: +(d.release_date || d.first_air_date || "").slice(0, 4) || 0,
    runtime: t === "movie" ? d.runtime || 0 : 0, seasons: t === "tv" ? d.number_of_seasons || 0 : 0,
    genres: (d.genres || []).map(g => g.name), vote: round1(d.vote_average), votes: d.vote_count || 0,
    poster: d.poster_path || null,
    overview: (d.overview || (en && en.data && en.data.overview) || "").slice(0, 700),
    directors: (t === "movie" ? ((d.credits && d.credits.crew) || []).filter(c => c.job === "Director") : d.created_by || []).map(p => p.name).slice(0, 3)
  });
}
const prevOffers = new Map();
if (previous && previous.region === region) for (const x of [...(previous.watchlist || []), ...(previous.tips || [])]) if (x.offers && x.id) prevOffers.set(`${x.t}:${x.id}`, x.offers);
let offerMisses = 0;
async function offers(t, id) {
  try {
    const d = await tmdb(`/${t}/${id}/watch/providers`);
    const r = (d && d.results && d.results[region]) || {};
    const pick = k => (r[k] || []).map(p => { noteProvider(p); return p.provider_id; });
    return { link: r.link || null, flatrate: pick("flatrate"), free: pick("free"), ads: pick("ads"), rent: pick("rent"), buy: pick("buy") };
  } catch (e) {
    if (e instanceof Fatal) throw e;
    offerMisses++;
    return prevOffers.get(`${t}:${id}`) || null;               // liever het aanbod van gisteren dan niets
  }
}
async function recs(t, id) {
  const k = `${t}:${id}`, c = cache.recs[k];
  if (c && now - c.at < (25 + id % 10) * DAY) return c.items;
  const d = await tmdb(`/${t}/${id}/recommendations`, { language: LANG, page: 1 });
  const items = ((d && d.results) || []).map(r => ({
    t: r.media_type === "tv" || r.media_type === "movie" ? r.media_type : t, id: r.id,
    title: r.title || r.name || "", orig: r.original_title || r.original_name || "",
    year: +(r.release_date || r.first_air_date || "").slice(0, 4) || 0, poster: r.poster_path || null,
    vote: round1(r.vote_average), votes: r.vote_count || 0, overview: (r.overview || "").slice(0, 400)
  }));
  cache.recs[k] = { at: now, items };
  return items;
}

try {
  // Catalogus van diensten in dit land
  const prio = new Map();
  for (const kind of ["movie", "tv"]) {
    const d = await tmdb("/watch/providers/" + kind, { watch_region: region, language: LANG });
    for (const p of (d && d.results) || []) {
      noteProvider(p);
      const pr = (p.display_priorities && p.display_priorities[region]) ?? p.display_priority ?? 999;
      if (!prio.has(p.provider_id) || pr < prio.get(p.provider_id)) prio.set(p.provider_id, pr);
    }
  }
  const catalog = [...prio].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const wanted = (config.services || []).map(String);
  const defaultServices = [];
  for (const name of wanted) {
    const id = catalog.find(id => norm(provInfo[id].name) === norm(name));
    if (id) defaultServices.push(id); else warn(`De dienst "${name}" uit config.json staat in ${region} niet zo in de catalogus. Kies hem in de app, of neem de naam precies over.`);
  }

  // Watchlist: opzoeken, details, aanbod
  const wl = watchlist.filter(filmOrSeries);
  const skipped = watchlist.length - wl.length;
  await pool([...wl, ...ratings.filter(filmOrSeries)], resolve);
  const ratingOf = new Map(ratings.map(r => [r.imdb, r.rating]));
  const outList = [];
  await pool(wl, async (w) => {
    const m = cache.find[w.imdb];
    const base = { imdb: w.imdb, pos: watchlist.indexOf(w), title: w.title, orig: w.orig, year: w.year, seen: ratingOf.get(w.imdb) || 0 };
    if (!m || m.miss) { outList.push({ ...base, found: false, t: kindOf(w.type), genres: [], directors: [] }); return; }
    const d = await details(m.t, m.id) || {};
    outList.push({
      ...base, found: true, t: m.t, id: m.id,
      title: w.title || d.title || "", orig: w.orig || d.orig || "", year: w.year || d.year || 0,
      runtime: d.runtime || 0, seasons: d.seasons || 0, genres: d.genres || [], vote: d.vote || 0,
      poster: d.poster || null, overview: d.overview || "", directors: d.directors || [],
      offers: await offers(m.t, m.id)
    });
  });
  outList.sort((a, b) => a.pos - b.pos);
  const missing = outList.filter(x => !x.found).length;
  log(`TMDB: ${outList.length - missing} gevonden, ${missing} niet gevonden${skipped ? ", " + skipped + " overgeslagen (geen film of serie)" : ""}`);

  // Tips
  const seeds = [];
  ratings.filter(r => r.rating >= 7 && filmOrSeries(r)).sort((a, b) => b.rating - a.rating || b.rated.localeCompare(a.rated)).slice(0, 30)
    .forEach(r => seeds.push({ imdb: r.imdb, title: r.title, w: r.rating - 6, rating: r.rating }));
  const used = new Set(seeds.map(s => s.imdb));
  wl.filter(w => !used.has(w.imdb) && !ratingOf.get(w.imdb)).slice(-30).reverse()
    .forEach(w => seeds.push({ imdb: w.imdb, title: w.title, w: 1.5, rating: 0 }));
  const live = seeds.filter(s => cache.find[s.imdb] && !cache.find[s.imdb].miss);
  await pool(live, async s => { const m = cache.find[s.imdb]; s.recs = await recs(m.t, m.id); });

  const known = new Set(), titles = new Set();
  for (const it of [...watchlist, ...ratings]) {
    const m = cache.find[it.imdb]; if (m && !m.miss) known.add(m.t + ":" + m.id);
    for (const t of [it.title, it.orig]) if (t) for (const dy of [-1, 0, 1]) titles.add(norm(t) + "|" + ((+it.year || 0) + dy));
  }
  const cand = new Map();
  for (const s of live) (s.recs || []).forEach((r, i) => {
    const key = r.t + ":" + r.id;
    if (known.has(key) || r.votes < 150) return;
    if (titles.has(norm(r.title) + "|" + r.year) || titles.has(norm(r.orig) + "|" + r.year)) return;
    const c = cand.get(key) || { ...r, raw: 0, why: [] };
    const part = s.w / (1 + i / 8);
    c.raw += part; c.why.push({ title: s.title, rating: s.rating, part });
    cand.set(key, c);
  });
  const tips = [...cand.values()].map(c => {
    c.why.sort((a, b) => b.part - a.part);
    return { t: c.t, id: c.id, title: c.title, orig: c.orig, year: c.year, poster: c.poster, vote: c.vote, overview: c.overview,
      score: Math.round(c.raw * (0.5 + c.vote / 20) * 100) / 100, why: c.why.slice(0, 2).map(w => ({ title: w.title, rating: w.rating })) };
  }).sort((a, b) => b.score - a.score).slice(0, 60);
  await pool(tips, async t => { t.offers = await offers(t.t, t.id); });
  log(`Tips: ${tips.length} uit ${live.length} uitgangstitels`);
  if (offerMisses) warn(`Voor ${offerMisses} titels kon het aanbod vandaag niet worden opgehaald; daar staat het aanbod van de vorige keer.`);

  // Alleen diensten bewaren die ergens voorkomen of in de catalogus staan
  const usedIds = new Set(catalog);
  for (const x of [...outList, ...tips]) if (x.offers) for (const k of ["flatrate", "free", "ads", "rent", "buy"]) x.offers[k].forEach(id => usedIds.add(id));
  const providers = {};
  for (const id of usedIds) if (provInfo[id]) providers[id] = provInfo[id];

  // Cache opschonen: wat niet meer op een lijst staat hoeft niet bewaard te blijven
  const keepImdb = new Set([...watchlist, ...ratings].map(x => x.imdb));
  for (const k of Object.keys(cache.find)) if (!keepImdb.has(k)) delete cache.find[k];
  const keepDetails = new Set(outList.filter(x => x.found).map(x => `${x.t}:${x.id}`));
  for (const k of Object.keys(cache.details)) if (!keepDetails.has(k)) delete cache.details[k];
  const keepRecs = new Set(live.map(s => { const m = cache.find[s.imdb]; return m ? `${m.t}:${m.id}` : ""; }));
  for (const k of Object.keys(cache.recs)) if (!keepRecs.has(k)) delete cache.recs[k];

  await writeJson("site/data/data.json", {
    version: 1, generatedAt: new Date(now).toISOString(), region, nick: user.nick || "",
    stats: { watchlist: outList.length, ratings: ratings.length, skipped },
    defaultServices, catalog, providers, watchlist: outList, tips, warnings
  }, 1);
  await writeJson("cache/cache.json", cache, 0);
  log(`Klaar: ${tmdbCalls} TMDB-aanvragen, ${warnings.length} waarschuwing(en).`);
} catch (e) {
  fail(e.message);
}
