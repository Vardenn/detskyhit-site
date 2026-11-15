// Detsky Hit — Cloudflare Worker (Workers + Static Assets)
// - Статические файлы сайта: отдаются из assets (binding ASSETS)
// - /api/catalog и /.netlify/functions/catalog: читает/пишет каталог в Supabase
const CATALOG_PATHS = new Set(['/api/catalog', '/.netlify/functions/catalog']);
const RESET_PATHS = new Set(['/api/reset']);

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}
function randomBytesHex(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return bufToHex(buf);
}
async function getSetting(env, key) {
  const r = await supa(env, 'settings?select=value&key=eq.' + encodeURIComponent(key));
  if (r.status !== 200) return null;
  try { const arr = JSON.parse(r.text); return arr.length ? String(arr[0].value) : null; }
  catch { return null; }
}
async function setSetting(env, key, value) {
  await supa(env, 'settings', { method: 'POST', body: [{ key, value: String(value) }], prefer: 'resolution=merge-duplicates' });
}
async function deleteSetting(env, key) {
  await supa(env, 'settings?key=eq.' + encodeURIComponent(key), { method: 'DELETE' });
}
async function ensureAdminPassword(env) {
  let salt = await getSetting(env, 'admin_salt');
  if (salt) return salt;
  const src = env.DETS_ADMIN_PASSWORD || 'Detskyhit2026@';
  salt = randomBytesHex(16);
  const hash = await sha256Hex(salt + ':' + src);
  await setSetting(env, 'admin_salt', salt);
  await setSetting(env, 'admin_hash', hash);
  return salt;
}
async function checkAdminPassword(env, candidate) {
  const salt = await ensureAdminPassword(env);
  const expected = await getSetting(env, 'admin_hash');
  if (!expected) return false;
  const candidateHash = await sha256Hex(salt + ':' + candidate);
  return candidateHash === expected;
}
const RESET_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RESET_ATTEMPTS = 3;
const RESET_LOCKOUT_MS = 15 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;

const UPLOAD_PATHS = new Set(['/api/upload']);

async function handleReset(request, env) {
  const url = new URL(request.url);
  let action = url.searchParams.get('action') || '';
  let body = {};
  try { body = await request.json(); } catch {}
  if (!action) action = String(body.action || '');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();

  if (action === 'request') {
    const rateKey = 'reset_rate_' + ip;
    const last = await getSetting(env, rateKey);
    if (last && (now - Number(last)) < RESET_COOLDOWN_MS) {
      return json({ error: 'Подождите минуту перед следующей заявкой' }, 429);
    }
    const lockedUntil = await getSetting(env, 'reset_locked_until');
    if (lockedUntil && Number(lockedUntil) > now) {
      const left = Math.ceil((Number(lockedUntil) - now) / 60000);
      return json({ error: `Заблокировано. Попробуйте через ${left} мин.` }, 423);
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256Hex('reset:' + code);
    await setSetting(env, 'reset_code_hash', codeHash);
    await setSetting(env, 'reset_expires', String(now + RESET_WINDOW_MS));
    await setSetting(env, 'reset_attempts', '0');
    await setSetting(env, rateKey, String(now));
    // --- email sending: requires external REST API (Workers cannot do raw SMTP) ---
    // Supported keys: RESEND_API_KEY (https://resend.com, 3000/mo free), SENDGRID_API_KEY (https://sendgrid.com, 100/day free)
    const recipient = 'detskyhit@gmail.com';
    const subject = 'Detsky Hit — код восстановления';
    const text = `Ваш код восстановления: ${code}\n\nКод действует 10 минут. Если вы не запрашивали восстановление, просто проигнорируйте письмо.`;
    try {
      if (env.RESEND_API_KEY) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.RESEND_API_KEY },
          body: JSON.stringify({ from: 'Detsky Hit <onboarding@resend.dev>', to: recipient, subject, text }),
        });
        if (!r.ok) { const t = await r.text(); return json({ error: 'Email не ушёл (Resend): ' + r.status + ' ' + t.slice(0, 120) }, 502); }
      } else if (env.SENDGRID_API_KEY) {
        const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY },
          body: JSON.stringify({ personalizations: [{ to: [{ email: recipient }] }], from: { email: recipient, name: 'Detsky Hit' }, subject, content: [{ type: 'text/plain', value: text }] }),
        });
        if (!r.ok) { const t = await r.text(); return json({ error: 'Email не ушёл (SendGrid): ' + r.status + ' ' + t.slice(0, 120) }, 502); }
      } else {
        // No mail provider configured; log code to Worker logs (visible in wrangler dash) — never to the client
        console.log('[reset] code for ' + ip + ' = ' + code);
        return json({ error: 'Почта не настроена (нужен RESEND_API_KEY или SENDGRID_API_KEY в Cloudflare Secrets)' }, 503);
      }
    } catch (e) {
      return json({ error: 'Email error: ' + (e && e.message ? e.message.slice(0, 120) : String(e)) }, 502);
    }
    return json({ ok: true, message: 'Код отправлен на Detskyhit@gmail.com' });
  }

  if (action === 'verify') {
    const code = String((body && body.code) || '').trim();
    if (!/^\d{6}$/.test(code)) return json({ error: 'Введите 6 цифр' }, 400);
    const lockedUntil = await getSetting(env, 'reset_locked_until');
    if (lockedUntil && Number(lockedUntil) > now) {
      const left = Math.ceil((Number(lockedUntil) - now) / 60000);
      return json({ error: `Заблокировано. Попробуйте через ${left} мин.` }, 423);
    }
    const expires = Number(await getSetting(env, 'reset_expires') || 0);
    if (Date.now() > expires) return json({ error: 'Код истёк' }, 410);
    const codeHash = await sha256Hex('reset:' + code);
    const expected = await getSetting(env, 'reset_code_hash');
    if (codeHash === expected && expected) {
      const resetToken = randomBytesHex(24);
      await setSetting(env, 'reset_token', resetToken);
      await setSetting(env, 'reset_token_expires', String(Date.now() + 5 * 60 * 1000));
      await deleteSetting(env, 'reset_code_hash');
      await deleteSetting(env, 'reset_expires');
      await deleteSetting(env, 'reset_attempts');
      return json({ ok: true, resetToken });
    }
    const attempts = Number((await getSetting(env, 'reset_attempts')) || 0) + 1;
    await setSetting(env, 'reset_attempts', String(attempts));
    if (attempts >= RESET_ATTEMPTS) {
      await setSetting(env, 'reset_locked_until', String(Date.now() + RESET_LOCKOUT_MS));
      await deleteSetting(env, 'reset_code_hash');
      await deleteSetting(env, 'reset_expires');
      await deleteSetting(env, 'reset_attempts');
      return json({ error: 'Слишком много попыток. Заблокировано на 15 минут.' }, 423);
    }
    return json({ error: `Неверный код. Осталось попыток: ${RESET_ATTEMPTS - attempts}` }, 401);
  }

  if (action === 'confirm') {
    const token = String((body && body.token) || '');
    const newPassword = String((body && body.newPassword) || '');
    if (!newPassword || newPassword.length < 8) return json({ error: 'Пароль должен быть не короче 8 символов' }, 400);
    if (!/[A-Za-zА-Яа-я]/.test(newPassword) || !/\d/.test(newPassword)) return json({ error: 'Пароль должен содержать буквы и цифры' }, 400);
    const expectedToken = await getSetting(env, 'reset_token');
    const tokenExpires = Number(await getSetting(env, 'reset_token_expires') || 0);
    if (!expectedToken || token !== expectedToken || Date.now() > tokenExpires) {
      return json({ error: 'Сессия подтверждения истекла. Повторите восстановление.' }, 401);
    }
    const salt = randomBytesHex(16);
    const hash = await sha256Hex(salt + ':' + newPassword);
    await setSetting(env, 'admin_salt', salt);
    await setSetting(env, 'admin_hash', hash);
    await deleteSetting(env, 'reset_token');
    await deleteSetting(env, 'reset_token_expires');
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
}

const INSTA_STATS_PATHS = new Set(['/api/insta-stats']);
const INSTA_HANDLE = 'detsky_hit';
const INSTA_TTL_MS = 60 * 60 * 1000; // обновляем не чаще, чем раз в час

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
    if (!(await checkAdminPassword(env, pwd))) return json({ error: 'Неверный пароль' }, 401);

    const products = Array.isArray(body.products) ? body.products : null;
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : null;

    // Только проверка пароля (без сохранения)
    if (!products && !settings) {
      const cat = await readCatalog(env);
      return json({ ok: true, ...cat });
    }

    if (products) {
      if (!Array.isArray(products) || products.length === 0) {
        return json({ error: 'Пустой список товаров — отмена сохранения. Если хотите очистить каталог, используйте Админку → Удалить товары по одному.' }, 400);
      }
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


async function fetchInstagramStats() {
  try {
    const res = await fetch(`https://www.instagram.com/${INSTA_HANDLE}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    if (!res.ok) return null;
    const body = await res.text();
    const m = body.match(/([\d,]+)\s+Followers,\s*([\d,]+)\s+Following,\s*([\d,]+)\s+Posts/);
    if (!m) return null;
    const n = s => Number(String(s).replace(/,/g, '')) || 0;
    return { followers: n(m[1]), following: n(m[2]), posts: n(m[3]) };
  } catch (e) {
    return null;
  }
}

async function instaStats(env) {
  const rows = await supa(env, 'settings?select=*&key=in.(instagram_followers,instagram_following,instagram_posts,insta_fetched_at)');
  const map = {};
  if (rows.status === 200) {
    try {
      for (const r of JSON.parse(rows.text)) map[r.key] = r.value;
    } catch {}
  }
  const fetched = Number(map.insta_fetched_at || 0);
  const cached = {
    followers: +map.instagram_followers || 0,
    following: +map.instagram_following || 0,
    posts: +map.instagram_posts || 0,
    fetchedAt: fetched || null,
  };
  if (Date.now() - fetched < INSTA_TTL_MS && map.instagram_followers !== undefined) {
    return { ok: true, ...cached, fromCache: true };
  }
  const fresh = await fetchInstagramStats();
  if (fresh) {
    const now = Date.now();
    const rows2 = [
      { key: 'instagram_followers', value: String(fresh.followers) },
      { key: 'instagram_following', value: String(fresh.following) },
      { key: 'instagram_posts', value: String(fresh.posts) },
      { key: 'insta_fetched_at', value: String(now) },
    ];
    await supa(env, 'settings', { method: 'POST', body: rows2, prefer: 'resolution=merge-duplicates' });
    return { ok: true, ...fresh, fetchedAt: now, fromCache: false };
  }
  return { ok: true, ...cached, fromCache: true, stale: true };
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
    if (INSTA_STATS_PATHS.has(url.pathname)) {
      return json(await instaStats(env));
    }
    if (RESET_PATHS.has(url.pathname)) {
      return handleReset(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
