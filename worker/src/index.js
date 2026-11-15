// Thin proxy: the browser sends only `messages`; model, system prompt and tool
// definitions are fixed here so the key can't be used as a general Claude endpoint.
const MODEL = "claude-opus-5-5";
const MAX_BODY = 300_000;
const MAX_MESSAGES = 60;

const SYSTEM = `You are Shopping Therapy, a friendly resale advisor. The user sells designer clothes secondhand (Poshmark-style, items $100+) and asks what to price a piece at and how fast it will sell.

Ground every number in the tools, never invent stats:
- brand_stats: per-brand share sold within 7 days and median asking price (33 brands).
- drivers: what correlates with selling within a week (price vs brand median, type, size, condition, photos, etc.) as multipliers.
- sell_odds: share of listings sold by day 7/30/90/180, filtered by brand, type, size, condition and price vs original retail. Only 9 brands have this item-level data. Call it several times in parallel to compare price tiers.

Answer shape (short, chatty, no headings):
1. Suggested list price as a $ range, with why (brand median, % of retail tier).
2. How soon it should sell: odds by 1 week / 1 month / 3 months, quoting the sample size.
3. Flag clearly if it might not sell (e.g. under 40% sold by 3 months), and the one or two changes that would help most.
If a brand or category isn't in the data, say so plainly and reason from the closest brands or overall drivers. Ask one short question only if brand or item type is missing. Data: Poshmark listings Oct 13 to Nov 4, 2026, so autumn seasonality applies.`;

const DIM = {
  type: ["Dresses","Tops","Sweaters","Shoes","Jackets & Coats","Bags","Pants & Jumpsuits","Jeans","Skirts","Other"],
  size: ["XXS–XS / 0–2","S / 4–6","M / 8","L+ / 10+","One size","Shoe sizes","Other"],
  condition: ["New with tags","Used, like new","Used, good","Used, fair","Not stated"],
  price_vs_retail: ["Under 35% of retail","35–55% of retail","55–75% of retail","75%+ of retail","No retail price given"],
};
const TOOLS = [
  { name: "brand_stats", description: "Headline ranking: share of listings sold within 7 days and median asking price for one brand, or all 33 brands if brand is omitted. Comes from a broader crawl than sell_odds, so the 7-day numbers differ; use it to compare brands and for pricing, and prefer sell_odds for timing where available.",
    input_schema: { type: "object", properties: { brand: { type: "string" } }, additionalProperties: false } },
  { name: "drivers", description: "Factors linked to faster or slower sales within 7 days, as multipliers vs average (1.5x = 50% more likely).",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "sell_odds", description: "Share of matching listings sold by day 7, 30, 90 and 180 (low-high range), with sample size. Item-level data covers: Dôen, Sézane, Khaite, Lemaire, Maison Margiela, Orseund Iris, Paloma Wool, Realisation Par, The Row. Omit a filter to include all values.",
    input_schema: { type: "object", additionalProperties: false, properties: {
      brand: { type: "string" },
      type: { type: "string", enum: DIM.type },
      size: { type: "string", enum: DIM.size },
      condition: { type: "string", enum: DIM.condition },
      price_vs_retail: { type: "string", enum: DIM.price_vs_retail },
    } } },
];

function cors(origin, env) {
  const ok = (env.ALLOWED_ORIGINS || "").split(",").includes(origin);
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" } : null;
}
const json = (status, obj, h = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...h } });

// Logs "request a new brand" submissions from the pricing engine. Read back with:
//   npx wrangler kv key list --binding BRAND_REQUESTS --remote   (keys hold the request)
async function brandRequest(req, env, h) {
  let body;
  try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch { return json(400, { error: "bad json" }, h); }
  const brand = String(body.brand || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (brand.length < 2) return json(400, { error: "brand missing" }, h);
  const ctx = { type: String(body.type || "").slice(0, 40), retail: Number(body.retail) || null };
  const key = `req:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.BRAND_REQUESTS.put(key, JSON.stringify({ brand, ...ctx, country: req.cf?.country || null }), { metadata: { brand } });
  return json(200, { ok: true }, h);
}

// Live comps: cheapest active + most recent sold Poshmark listings for a search query.
async function pmSearch(q, availability, sort) {
  const u = "https://poshmark.com/search?" + new URLSearchParams({ query: q, type: "listings", availability, sort_by: sort, "price[]": "20-" });
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }, cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error("poshmark " + r.status);
  const html = await r.text(), k = html.indexOf("window.__INITIAL_STATE__=");
  if (k < 0) throw new Error("no listings in page");
  let depth = 0, i = k + 25, j = i, inStr = false, esc = false;
  for (; j < html.length; j++) { const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true; else if (c === "{" || c === "[") depth++; else if (c === "}" || c === "]") { depth--; if (!depth) { j++; break } } }
  const out = [], seen = new Set();
  (function walk(o) { if (Array.isArray(o)) return o.forEach(walk); if (!o || typeof o !== "object") return;
    if (o.inventory && o.first_published_at && o.id) { if (!seen.has(o.id)) { seen.add(o.id);
      out.push({ title: o.title, price: Number(o.price_amount?.val || 0), first: Number(o.first_user_price_amount?.val || 0), size: o.size || "", cond: o.condition || "",
        brand: o.brand || "", url: "https://poshmark.com/listing/" + o.id, sold: o.inventory.status === "sold_out", at: o.inventory.status_changed_at || o.first_published_at }) } return }
    Object.values(o).forEach(walk) })(JSON.parse(html.slice(i, j)));
  return out;
}
async function comps(req, h) {
  let body; try { body = JSON.parse((await req.text()).slice(0, 1000)); } catch { return json(400, { error: "bad json" }, h); }
  const q = String(body.q || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (q.length < 3) return json(400, { error: "query too short" }, h);
  try {
    const [active, sold] = await Promise.all([pmSearch(q, "available", "price_asc"), pmSearch(q, "sold_out", "added_desc")]);
    return json(200, { q, active: active.slice(0, 10), sold: sold.filter(x => x.sold).slice(0, 10) }, h);
  } catch (e) { return json(502, { error: String(e.message || e) }, h); }
}

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get("Origin") || "", env);
    if (!h) return json(403, { error: "origin not allowed" });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return json(405, { error: "POST only" }, h);
    if (new URL(req.url).pathname === "/brand-request") return brandRequest(req, env, h);
    if (new URL(req.url).pathname === "/comps") return comps(req, h);
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: "conversation too long, start a new chat" }, h);
    let messages;
    try { ({ messages } = JSON.parse(raw)); } catch { return json(400, { error: "bad json" }, h); }
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES)
      return json(400, { error: "bad messages" }, h);

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, stream: true, system: SYSTEM, tools: TOOLS,
        output_config: { effort: "low" }, fallbacks: "default", messages }),
    });
    if (!upstream.ok) return json(upstream.status, { error: (await upstream.text()).slice(0, 500) }, h);
    return new Response(upstream.body, { headers: { ...h, "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
};
