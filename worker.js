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

// ---------- AI assistant (Этап 1: read + propose/apply, только одиночные правки) ----------
const AI_PATHS = new Set(['/api/ai', '/api/ai/apply', '/api/ai/voice']);
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_RATE_LIMIT = 30;
const AI_RATE_WINDOW_MS = 10 * 60 * 1000;
const AI_WHITELIST = new Set(['price', 'title', 'description', 'season', 'active']);
const AI_SEASONS = ['зима', 'осень', 'весна', 'лето'];

async function aiRateOk(env, ip) {
  const key = 'ai_rate_' + ip;
  const last = await getSetting(env, key);
  const now = Date.now();
  let windowStart = now, count = 0;
  try { const parsed = JSON.parse(last || '{}'); windowStart = parsed.t || now; count = parsed.n || 0; } catch {}
  if (now - windowStart > AI_RATE_WINDOW_MS) { windowStart = now; count = 0; }
  count += 1;
  await setSetting(env, key, JSON.stringify({ t: windowStart, n: count }));
  return count <= AI_RATE_LIMIT;
}

function compactCatalog(products, meta) {
  return products.map(p => {
    const m = meta[p.id] || {};
    return [p.id, p.article, String(p.title || '').slice(0, 60), p.price, p.category || '', m.season || '', m.active === false ? 'off' : 'on'].join(' | ');
  }).join('\n');
}

const AI_SYSTEM = `Ты — AI-помощник администратора магазина детской одежды «Detsky Hit» (Караганда, ТД Таир 3). Отвечай на русском, коротко и по делу.

СТРОГИЙ ФОРМАТ ОТВЕТА: только один JSON-объект, без markdown и пояснений вокруг:
{"reply": "<короткий ответ пользователю>", "proposal": null | {"type":"updateProduct","id":"<id товара из СПИСКА>","changes":{...}}}

ЧТО ТЫ УМЕЕШЬ:
- Отвечать на вопросы по каталогу по СПИСКУ ТОВАРОВ ниже.
- Предлагать ОДИНОЧНОЕ изменение товара (proposal) с полями:
  price — строка «<число> KZT» (например "25300 KZT");
  title — строка до 120 символов;
  description — строка до 500 символов (может быть пустой);
  season — одно из: зима, осень, весна, лето;
  active — true (активна) или false (выключена).

ЗАПРЕЩЕНО:
- Предлагать массовые действия (несколько товаров) — скажи, что пока можно менять только по одному.
- Предлагать удаление товаров, очистку каталога, правку паролей/ключей/секретов, настроек сайта, файлов, деплой — вежливо откажись.
- Выдумывать id товаров — берите id только из СПИСКА. Если не нашёл товар — спроси артикул или название.
- Писать цену словами — нормализуй в «<число> KZT».
- Отвечать не в JSON — модель обязана вернуть ровно один JSON-объект.

Если нашёл нужный товар и можешь предложить правку — указывай proposal. Если не уверен — переспроси (proposal=null).
Пользователь применяет предложение кнопкой, сам ты ничего не меняешь.`;

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function normalizePrice(v) {
  const digits = String(v == null ? '' : v).replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 100 || n > 100000000) return null;
  return String(n) + ' KZT';
}

function validateProposal(proposal, products) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, error: 'нет предложения' };
  if (proposal.type !== 'updateProduct') return { ok: false, error: 'неизвестное действие' };
  const p = products.find(x => x.id === String(proposal.id || ''));
  if (!p) return { ok: false, error: 'товар не найден' };
  const raw = proposal.changes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'нет изменений' };
  for (const k of Object.keys(raw)) {
    if (!AI_WHITELIST.has(k)) return { ok: false, error: `поле «${k}» менять нельзя` };
  }
  const changes = {};
  if ('price' in raw) { const pr = normalizePrice(raw.price); if (!pr) return { ok: false, error: 'цена должна быть числом (например «25300 KZT»)' }; changes.price = pr; }
  if ('title' in raw) { const t = String(raw.title || '').trim().slice(0, 120); if (!t) return { ok: false, error: 'пустое название' }; changes.title = t; }
  if ('description' in raw) { changes.description = String(raw.description == null ? '' : raw.description).trim().slice(0, 500); }
  if ('season' in raw) { const s = String(raw.season || '').trim().toLowerCase(); if (!AI_SEASONS.includes(s)) return { ok: false, error: 'сезон: зима/осень/весна/лето' }; changes.season = s; }
  if ('active' in raw) {
    const a = raw.active;
    changes.active = typeof a === 'boolean' ? a : !(String(a).trim().toLowerCase() === 'false' || String(a).trim() === '0');
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'нечего менять' };
  return { ok: true, product: p, changes };
}

async function handleAi(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Сервер не настроен' }, 500);
  if (request.method !== 'POST') return json({ error: 'Method' }, 405);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }
  if (!(await checkAdminPassword(env, String(body.password || '')))) return json({ error: 'Неверный пароль' }, 401);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await aiRateOk(env, ip))) return json({ error: 'Слишком много запросов, попробуйте через 10 минут' }, 429);
  if (!env.AI) return json({ error: 'AI binding не настроен' }, 503);

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages.slice(-10).map(m => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 1000),
  }));
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser || !lastUser.content.trim()) return json({ error: 'Пустая команда' }, 400);

  const { products, settings } = await readCatalog(env);
  let meta = {};
  try { meta = JSON.parse(settings.product_meta || '{}'); } catch {}
  const system = AI_SYSTEM + '\n\nСПИСОК ТОВАРОВ (id | артикул | название | цена | категория | сезон | статус):\n' + compactCatalog(products, meta);

  let resp;
  try {
    resp = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.2,
      max_tokens: 800,
    });
  } catch (e) {
    return json({ error: 'AI недоступен: ' + (e && e.message ? e.message.slice(0, 200) : String(e)) }, 502);
  }
  let text = '';
  const msg = resp && typeof resp === 'object' && !Array.isArray(resp) && resp.choices && resp.choices[0] && resp.choices[0].message ? resp.choices[0].message.content : null;
  const candidates = [typeof resp === 'string' ? resp : null, resp && resp.response, resp && resp.text, resp && resp.output, msg];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) { text = cand; break; }
  }
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.reply !== 'string') {
    return json({ ok: true, reply: 'Не смог разобрать ответ модели. Сформулируйте проще, например: «арт. 13398 цену 25000».', proposal: null });
  }
  let reply = String(parsed.reply).slice(0, 600);
  let proposal = null;
  if (parsed.proposal) {
    const v = validateProposal(parsed.proposal, products);
    if (v.ok) {
      proposal = { type: 'updateProduct', id: v.product.id, changes: v.changes };
    } else {
      reply = (reply ? reply + '\n\n' : '') + 'Но изменить не смогу: ' + v.error + '.';
    }
  }
  return json({ ok: true, reply, proposal });
}

async function handleAiVoice(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Сервер не настроен' }, 500);
  if (request.method !== 'POST') return json({ error: 'Method' }, 405);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }
  if (!(await checkAdminPassword(env, String(body.password || '')))) return json({ error: 'Неверный пароль' }, 401);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await aiRateOk(env, ip))) return json({ error: 'Слишком много запросов, попробуйте через 10 минут' }, 429);
  const ct = String(body.contentType || 'audio/webm');
  if (!/^audio\/(webm|ogg|oga|opus|mp4|mpeg|wav|x-m4a|m4a)$/i.test(ct)) return json({ error: 'Неподдерживаемый тип аудио' }, 400);
  const b64 = String(body.data || '').replace(/^data:[^,]+,/, '');
  if (!b64) return json({ error: 'Нет аудио' }, 400);
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return json({ error: 'Повреждённый файл' }, 400); }
  if (bytes.length > 8 * 1024 * 1024) return json({ error: 'Слишком большое аудио (максимум 8 МБ)' }, 413);
  if (!env.AI) return json({ error: 'AI binding не настроен' }, 503);
  let resp;
  try {
    resp = await env.AI.run('@cf/openai/whisper', { audio: Array.from(bytes) });
  } catch (e) {
    return json({ error: 'Whisper недоступен: ' + (e && e.message ? e.message.slice(0, 300) : String(e)) }, 502);
  }
  const text = resp && (resp.text || resp.response || (resp.result && resp.result.text) || '');
  const trimmed = String(text || '').trim();
  if (!trimmed) return json({ text: '', error: 'Не расслышал, скажи еще раз, чуть медленнее' });
  return json({ text: trimmed });
}

async function handleAiApply(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Сервер не настроен' }, 500);
  if (request.method !== 'POST') return json({ error: 'Method' }, 405);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }
  if (!(await checkAdminPassword(env, String(body.password || '')))) return json({ error: 'Неверный пароль' }, 401);

  const { products, settings } = await readCatalog(env);
  const v = validateProposal(body.proposal, products);
  if (!v.ok) return json({ error: 'Изменение отклонено: ' + v.error }, 400);

  let meta = {};
  try { meta = JSON.parse(settings.product_meta || '{}'); } catch {}
  const metaBefore = meta[v.product.id] || {};
  const before = { price: v.product.price, title: v.product.title, description: v.product.description, season: metaBefore.season || null, active: metaBefore.active !== false };

  const productChanges = {};
  if ('price' in v.changes) productChanges.price = v.changes.price;
  if ('title' in v.changes) productChanges.title = v.changes.title;
  if ('description' in v.changes) productChanges.description = v.changes.description;
  if (Object.keys(productChanges).length) {
    const merged = { ...v.product, ...productChanges };
    const up = await supa(env, 'products', { method: 'POST', body: [merged], prefer: 'resolution=merge-duplicates' });
    if (up.status !== 201 && up.status !== 200) {
      return json({ error: 'Не удалось сохранить товар', details: String(up.text).slice(0, 200) }, 502);
    }
  }
  if ('season' in v.changes || 'active' in v.changes) {
    const m = { ...(meta[v.product.id] || {}) };
    if ('season' in v.changes) m.season = v.changes.season;
    if ('active' in v.changes) m.active = v.changes.active;
    meta[v.product.id] = m;
    await setSetting(env, 'product_meta', JSON.stringify(meta));
  }
  const metaAfter = meta[v.product.id] || {};
  const after = {
    price: productChanges.price || v.product.price,
    title: productChanges.title || v.product.title,
    description: 'description' in productChanges ? productChanges.description : (v.product.description || ''),
    season: 'season' in v.changes ? v.changes.season : (metaAfter.season || null),
    active: 'active' in v.changes ? v.changes.active : (metaAfter.active !== false),
  };

  let log = [];
  try { log = JSON.parse(settings.ai_log || '[]'); if (!Array.isArray(log)) log = []; } catch { log = []; }
  log.unshift({ t: Date.now(), type: 'apply', id: v.product.id, article: v.product.article, changes: v.changes, before, after });
  if (log.length > 50) log.length = 50;
  await setSetting(env, 'ai_log', JSON.stringify(log));

  return json({ ok: true, after });
}

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
const _AUTOFILL = new Set(['/api/ai/autofill']);
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

async function imageToDataUri(url, base) {
  // data:URI already — trust it, just size-cap
  if (/^data:image\//i.test(url)) {
    const approx = Math.floor(String(url).length * 3 / 4);
    if (approx > 4 * 1024 * 1024) throw new Error('image too big');
    return { dataUri: url, bytes: null };
  }
  let resolved;
  if (/^https?:\/\//i.test(url)) resolved = url;
  else if (String(url).startsWith('/')) resolved = base.origin + url;
  else resolved = base.origin + '/' + url;
  const r = await fetch(resolved, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || 'image/jpeg';
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 4 * 1024 * 1024) throw new Error('image too big');
  let str = '';
  const CHUNK = 0x4000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { dataUri: `data:${ct};base64,${btoa(str)}`, bytes };
}

// ---------- AI: описание товара по фото (vision per image → text LLM JSON) ----------
async function handleAiAutofill(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Сервер не настроен' }, 500);
  if (request.method !== 'POST') return json({ error: 'Method' }, 405);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }
  if (!(await checkAdminPassword(env, String(body.password || '')))) return json({ error: 'Неверный пароль' }, 401);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await aiRateOk(env, ip))) return json({ error: 'Слишком много запросов, попробуйте через 10 минут' }, 429);
  const images = Array.isArray(body.images) ? body.images.slice(0, 4).filter(u => typeof u === 'string' && u.trim()) : [];
  if (!images.length) return json({ error: 'Сначала загрузите хотя бы одно фото' }, 400);
  const base = new URL(request.url);
  const textFromAi = r => {
    if (!r) return '';
    if (typeof r === 'string') return r;
    console.log('R TYPE:', typeof r, 'R KEYS:', r && typeof r === 'object' ? JSON.stringify(Object.keys(r)) : 'n/a');
    if (r && r.response && typeof r.response === 'object') console.log('R.RESPONSE KEYS:', JSON.stringify(Object.keys(r.response).slice(0, 10)), 'SAMPLE:', JSON.stringify(r.response).slice(0, 800));
    const direct = r.response || r.text || r.output;
    if (typeof direct === 'string') return direct;
    if (direct) return String(direct);
    const choices = r.choices;
    if (Array.isArray(choices) && choices[0] && choices[0].message) return String(choices[0].message.content || '');
    return String(r);
  };
  // 1) Vision pass per photo: collect raw visible details
  const visionPrompt = 'Перечисли по-русски через запятую только то, что ВИДНО на этом фото товара: цвет, есть ли капюшон, какой тип застёжки (молния или пуговицы), какие карманы, длина, тёплая ли (пуховая/мембранная/трикотаж/лен/шорты), подсказки по полу. Если что-то не видно — так и скажи, не придумывай. Одно-два коротких предложения без вступлений.';
  const descriptions = [];
  for (const u of images) {
    try {
      const { dataUri } = await imageToDataUri(u, base);
      const r = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: [ { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUri, detail: 'auto' } },
          { type: 'text', text: visionPrompt },
        ] } ],
        max_tokens: 220, temperature: 0.3,
      });
      const s = textFromAi(r).trim();
      if (s) descriptions.push(s);
    } catch (e) {
      console.log('vision failed for', u, e && e.message ? e.message : String(e));
    }
  }
  if (!descriptions.length) return json({ error: 'Не смог разглядеть, попробуй ещё раз' }, 502);
  // 2) Text LLM: combine descriptions → strict JSON
  const aggregate = descriptions.map((d, i) => `Фото ${i + 1}: ${d}`).join('\n');
  const sys = [
    'Ты AI-помощник администратора магазина детской одежды «Detsky Hit». В базе товар — тебе дают описания по фотографиям одного и того же товара.',
    'Верни СТРОГО JSON-объект без markdown, без пояснений:',
    '{"title": "...", "description": "...", "category": "...", "season": "..."}',
    '',
    'Все фото в запросе — ОДИН и тот же товар. Верни ровно ОДИН JSON-объект на всё. Никаких других JSON-объектов, никаких комментариев вне JSON.',
    '',
    'Правила:',
    '- title: короткое название КАПСОМ на английском, формат: тип товара + цвет (KURTKA GRAY, HOODIE BLACK, SWEATER BEIGE, SHIRT BLUE, PANTS GRAY и т.п.). БЕЗ артикула.',
    '- description: 3–4 предложения на русском, простым языком для мамы. ТОЛЬКО то, что видно на фото (цвет, капюшон, молния/застёжка, карманы, длина, насколько тёплая, на какую погоду). Никаких вымышленных деталей. Если не уверена в цвете или поле — пиши «похоже ...» или «похоже на мальчиковый» без уверенности.',
    '- category: одна из: куртки, худи, рубашки, штаны. Если товар не подходит ни под одну (например, костюм, обувь) — верни пустую строку. Возвращай именно в нижнем регистре и во множественном числе: куртки.',
    '- season: зима | весна | лето | осень. Пустая строка если всесезонная и не очевидно.',
  ].join('\n');
  let final;
  try {
    final = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [ { role: 'system', content: sys }, { role: 'user', content: 'Описания по фото:\n' + aggregate } ],
      temperature: 0.2, max_tokens: 420,
    });
  } catch (e) {
    return json({ error: 'Не смог разглядеть, попробуй ещё раз' }, 502);
  }
  // Vision-модель может отдать готовый JSON-объект в .response — предпочитаем его
  let parsed = null;
  if (final && final.response && typeof final.response === 'object' && !Array.isArray(final.response) && (final.response.title !== undefined || final.response.description !== undefined)) {
    parsed = final.response;
  } else {
    const finalText = textFromAi(final);
    // находим все JSON-объекты в тексте; предпочитаем тот, в котором есть title
    const candidates = [];
    const src = String(finalText || '');
    let depth = 0, start = -1;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (src[i] === '}') { depth--; if (depth === 0 && start >= 0) { candidates.push(src.slice(start, i + 1)); start = -1; } }
    }
    for (const c of candidates) {
      try {
        const p = JSON.parse(c);
        if (p && typeof p === 'object' && (p.title || p.description)) { parsed = p; break; }
      } catch (_) {}
    }
    if (!parsed) {
      console.log('autofill final sample:', src.slice(0, 400));
      return json({ title: '', description: String(finalText || '').trim().slice(0, 800), category: '', season: '' });
    }
  }
  return json({
    title: String(parsed.title || '').trim().slice(0, 80),
    description: String(parsed.description || '').trim().slice(0, 800),
    category: String(parsed.category || '').trim().toLowerCase().slice(0, 40),
    season: String(parsed.season || '').trim().toLowerCase().slice(0, 20),
  });
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
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(ct)) return json({ error: 'Только JPEG/PNG/WebP/HEIC' }, 400);
  const b64 = String(body.data || '').replace(/^data:[^,]+,/, '');
  if (!b64) return json({ error: 'Нет данных изображения' }, 400);

  let bytes;
  try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return json({ error: 'Повреждённый файл' }, 400); }
  if (bytes.length > 4 * 1024 * 1024) return json({ error: 'Фото больше 4 МБ' }, 413);

  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('heic') ? 'heic' : ct.includes('heif') ? 'heif' : 'jpg';
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
    if (_AUTOFILL.has(url.pathname)) {
      return handleAiAutofill(request, env);
    }
    if (AI_PATHS.has(url.pathname)) {
      if (url.pathname === '/api/ai/voice') return handleAiVoice(request, env);
      return url.pathname === '/api/ai' ? handleAi(request, env) : handleAiApply(request, env);
    }
    if (RESET_PATHS.has(url.pathname)) {
      return handleReset(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
