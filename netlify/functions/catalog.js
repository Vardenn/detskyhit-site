// GET  /.netlify/functions/catalog
//   -> { products, settings }  (public read)
// POST /.netlify/functions/catalog
//   body: { password, products?, settings? }  (auth required for write / verify)
//   - If only { password } provided and matches -> { ok: true, products, settings }
//   - If password wrong -> 401
const URL_SUPABASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.DETS_ADMIN_PASSWORD || "detskyhit2026";

function unauthorized() {
  return { statusCode: 401, body: JSON.stringify({ error: "Неверный пароль" }) };
}
function missingConfig() {
  return {
    statusCode: 500,
    body: JSON.stringify({ error: "Сервер не настроен: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }),
  };
}
async function supa(path, method = "GET", body = null, prefer = "") {
  const res = await fetch(`${URL_SUPABASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  return { status: res.status, text };
}
async function readCatalog() {
  const p1 = await supa("products?select=*");
  const p2 = await supa("settings?select=*");
  const products = p1.status === 200 ? JSON.parse(p1.text) : [];
  const settingsRows = p2.status === 200 ? JSON.parse(p2.text) : [];
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  return { products, settings };
}
function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
}

exports.handler = async (event) => {
  if (!URL_SUPABASE || !SERVICE_KEY) return missingConfig();

  if (event.httpMethod === "GET") {
    const { products, settings } = await readCatalog();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products, settings }),
    };
  }

  if (event.httpMethod === "POST") {
    const body = parseBody(event);
    const pwd = String(body.password || "");
    if (pwd !== ADMIN_PASSWORD) return unauthorized();

    // Verify-only (no products/settings to write)
    const products = Array.isArray(body.products) ? body.products : null;
    const settings = body.settings && typeof body.settings === "object" ? body.settings : null;
    if (!products && !settings) {
      const cat = await readCatalog();
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, ...cat }) };
    }

    if (products) {
      for (const p of products) {
        if (!String(p.article || "").trim()) {
          return { statusCode: 400, body: JSON.stringify({ error: `У товара «${p.title || p.id}» не указан артикул` }) };
        }
      }
      // upsert products
      const upsertProducts = await supa("products", "POST", products, "resolution=merge-duplicates");
      if (upsertProducts.status !== 201 && upsertProducts.status !== 200) {
        return { statusCode: 502, body: JSON.stringify({ error: "Не удалось сохранить товары", details: upsertProducts.text }) };
      }
      // delete removed items
      const existing = await supa("products?select=id");
      if (existing.status === 200) {
        const ids = JSON.parse(existing.text).map(r => r.id);
        const keep = new Set(products.map(p => p.id));
        const remove = ids.filter(id => !keep.has(id));
        for (const id of remove) {
          await supa(`products?id=eq.${encodeURIComponent(id)}`, "DELETE");
        }
      }
    }

    if (settings) {
      const rows = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
      if (rows.length) {
        await supa("settings", "POST", rows, "resolution=merge-duplicates");
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method" }) };
};
