// Detsky Hit — Cloudflare Worker (Workers + Static Assets)
// - Статические файлы сайта: отдаются из assets (binding ASSETS)
// - /api/catalog и /.netlify/functions/catalog: читает/пишет каталог в Supabase
const CATALOG_PATHS = new Set(['/api/catalog', '/.netlify/functions/catalog']);
const UPLOAD_PATHS = new Set(['/api/upload']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function supa(env, path, { method = 'GET', body = null, prefer = '' } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function readCatalog(env) {
  const p1 = await supa(env, 'products?select=*');
  const p2 = await supa(env, 'settings?select=*');
  const products = p1.status === 200 ? JSON.parse(p1.text) : [];
  const settingsRows = p2.status === 200 ? JSON.parse(p2.text) : [];
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  return { products, settings };
}

async function handleCatalog(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Сервер не настроен: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  if (request.method === 'GET') {
    const { products, settings } = await readCatalog(env);
    return json({ products, settings });
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const pwd = String(body.password || '');
    if (pwd !== env.DETS_ADMIN_PASSWORD) return json({ error: 'Неверный пароль' }, 401);

    const products = Array.isArray(body.products) ? body.products : null;
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : null;

    // Только проверка пароля (без сохранения)
    if (!products && !settings) {
      const cat = await readCatalog(env);
      return json({ ok: true, ...cat });
    }

    if (products) {
      for (const p of products) {
        if (!String(p.article || '').trim()) {
          return json({ error: `У товара «${p.title || p.id}» не указан артикул` }, 400);
        }
      }
      const up = await supa(env, 'products', { method: 'POST', body: products, prefer: 'resolution=merge-duplicates' });
      if (up.status !== 201 && up.status !== 200) {
        return json({ error: 'Не удалось сохранить товары', details: up.text }, 502);
      }
      const existing = await supa(env, 'products?select=id');
      if (existing.status === 200) {
        const ids = JSON.parse(existing.text).map(r => r.id);
        const keep = new Set(products.map(p => p.id));
        for (const id of ids.filter(id => !keep.has(id))) {
          await supa(env, `products?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
      }
    }

    if (settings) {
      const rows = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
      if (rows.length) {
        await supa(env, 'settings', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates' });
      }
    }

    return json({ ok: true });
  }

  return json({ error: 'Method' }, 405);
}

async function handleUpload(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Сервер не настроен: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  if (request.method !== 'POST') return json({ error: 'Method' }, 405);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  if (String(body.password || '') !== env.DETS_ADMIN_PASSWORD) return json({ error: 'Неверный пароль' }, 401);

  const ct = String(body.contentType || 'image/jpeg');
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(ct)) return json({ error: 'Только JPEG/PNG/WebP' }, 400);
  const b64 = String(body.data || '').replace(/^data:[^,]+,/, '');
  if (!b64) return json({ error: 'Нет данных изображения' }, 400);

  let bytes;
  try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return json({ error: 'Повреждённый файл' }, 400); }
  if (bytes.length > 4 * 1024 * 1024) return json({ error: 'Фото больше 4 МБ' }, 413);

  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const stem = String(body.filename || 'photo')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'photo';
  const key = `products/${Date.now().toString(36)}-${stem}.${ext}`;

  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/product-images/${key}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': ct,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) return json({ error: 'Не удалось сохранить изображение', details: await res.text() }, 502);
  return json({ ok: true, url: `${env.SUPABASE_URL}/storage/v1/object/public/product-images/${key}` });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (CATALOG_PATHS.has(url.pathname)) {
      return handleCatalog(request, env);
    }
    if (UPLOAD_PATHS.has(url.pathname)) {
      return handleUpload(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
