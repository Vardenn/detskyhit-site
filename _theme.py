src = open("index.html", encoding="utf-8").read()

# A) early theme init in head, before <style>
old = "<meta name=\"theme-color\" content=\"#ffffff\">"
new = old + "\n<script>try{document.documentElement.dataset.theme = localStorage.getItem('dh-theme') || 'light';}catch(e){}</script>"
assert src.count(old) == 1
src = src.replace(old, new)

# B) replace <style>...</style> with themeable version
i = src.find("<style>")
j = src.find("</style>")
assert i != -1 and j != -1
css = """<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root,[data-theme="light"]{
  --bg:#ffffff; --shell:#ffffff; --top:#ffffff; --surface:#ffffff; --softer:#f4f4f4;
  --border:#e5e5e5; --chip-border:#d9d9d9; --text:#111111; --muted:#888888; --muted2:#666666; --desc:#444444; --hint:#999999;
  --chip-bg:#ffffff; --chip-active-bg:#111111; --chip-active-text:#ffffff; --chip-active-border:#111111;
  --avatar-bg:#111111; --avatar-text:#ffffff; --fav-soft:#ffffff;
}
[data-theme="gray"]{
  --bg:#d8d8dc; --shell:#d8d8dc; --top:#d8d8dc; --surface:#e9e9ed; --softer:#c1c1c6;
  --border:#b9b9bf; --chip-border:#adadb3; --text:#17171a; --muted:#4a4a50; --muted2:#333338; --desc:#26262c; --hint:#55555c;
  --chip-bg:#e4e4e8; --chip-active-bg:#17171a; --chip-active-text:#f2f2f4; --chip-active-border:#17171a;
  --avatar-bg:#17171a; --avatar-text:#f2f2f4; --fav-soft:#e9e9ed;
}
[data-theme="dark"]{
  --bg:#000000; --shell:#000000; --top:#000000; --surface:#111111; --softer:#1c1c1e;
  --border:#262626; --chip-border:#333333; --text:#f5f5f5; --muted:#a8a8a8; --muted2:#cfcfcf; --desc:#d0d0d0; --hint:#8a8a8a;
  --chip-bg:#161616; --chip-active-bg:#f5f5f5; --chip-active-text:#111111; --chip-active-border:#f5f5f5;
  --avatar-bg:#f5f5f5; --avatar-text:#111111; --fav-soft:#111111;
}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-x:hidden}
.shell{max-width:480px;margin:0 auto;min-height:100dvh;background:var(--shell);position:relative}
@media(min-width:520px){.shell{border-left:1px solid var(--border);border-right:1px solid var(--border)}}
.theme-strip{display:flex;align-items:center;justify-content:flex-start;height:26px;padding:0 14px;background:var(--top);border-bottom:1px solid var(--border);border:0;border-bottom:1px solid var(--border);width:100%;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);cursor:pointer;font-family:inherit;user-select:none;text-align:left}
.theme-strip:hover{color:var(--text)}
.top{position:sticky;top:0;z-index:30;background:var(--top);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:14px 16px;gap:8px}
.brand{font-weight:800;font-size:19px;letter-spacing:-.02em;line-height:1.1}
.brand small{display:block;font-weight:500;font-size:10px;letter-spacing:.18em;color:var(--muted);text-transform:uppercase}
.top-right{display:flex;gap:8px;align-items:center}
.icon-btn,.top-wa{display:flex;align-items:center;gap:6px;border:1px solid var(--text);border-radius:999px;padding:8px 12px;font-size:13px;font-weight:600;color:var(--text);background:var(--surface);cursor:pointer;text-decoration:none;white-space:nowrap}
.top-wa{border-color:#25d366;background:#25d366;color:#111;border:none}
.fav-badge{position:absolute;top:-6px;right:-6px;background:#c00;color:#fff;font-size:10px;border-radius:999px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 4px;font-weight:700}
.fav-wrap{position:relative}
.profile{display:flex;gap:18px;padding:18px 16px 14px;align-items:center}
.avatar{width:84px;height:84px;border-radius:50%;background:var(--avatar-bg);color:var(--avatar-text);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;flex:none}
.pstats{display:flex;gap:22px}
.pstat b{display:block;font-size:16px}
.pstat span{font-size:12px;color:var(--muted2)}
.pdesc{padding:0 16px 14px;font-size:13.5px;line-height:1.55;white-space:pre-line;color:var(--text)}
.chips{position:sticky;top:52px;z-index:25;background:var(--top);border-bottom:1px solid var(--border);display:flex;gap:8px;overflow-x:auto;padding:10px 12px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;padding:8px 15px;border:1px solid var(--chip-border);border-radius:999px;background:var(--chip-bg);color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
.chip.active{background:var(--chip-active-bg);color:var(--chip-active-text);border-color:var(--chip-active-border)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.tile{position:relative;aspect-ratio:1/1;background:var(--softer);border:0;padding:0;cursor:pointer;overflow:hidden}
.tile img{width:100%;height:100%;object-fit:contain;display:block}
.tag{position:absolute;left:0;right:0;bottom:0;padding:14px 6px 5px;color:#fff;font-size:11px;font-weight:700;background:linear-gradient(transparent,rgba(0,0,0,.55));text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fav-btn-tile{position:absolute;top:6px;right:6px;z-index:2;background:rgba(255,255,255,.88);border:0;border-radius:999px;width:28px;height:28px;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.viewer{position:fixed;inset:0;z-index:100;background:var(--shell);overflow-y:auto;overscroll-behavior:contain}
.viewer[hidden]{display:none}
.close{position:fixed;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:120;width:36px;height:36px;border-radius:50%;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:15px;cursor:pointer}
.post{border-bottom:1px solid var(--border)}
.ph{height:70vh;position:relative;background:var(--softer);display:flex;align-items:center;justify-content:center}
.car{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;height:100%;width:100%}
.car::-webkit-scrollbar{display:none}
.slide{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center;position:relative;background:var(--softer)}
.slide img{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}
.dots{position:absolute;bottom:12px;left:0;right:0;display:flex;justify-content:center;gap:6px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--border)}
.dot.on{background:var(--text)}
.bar{display:flex;align-items:center;gap:18px;padding:13px 16px;border-bottom:1px solid var(--border)}
.icon-btn{background:none;border:0;padding:0;cursor:pointer;font-size:21px;line-height:1;color:var(--text)}
.fav-btn{display:flex;align-items:center;gap:4px}
.fav-btn .heart{font-size:22px}
.fav-btn.fav .heart{color:#c00}
.cnt{font-size:13px;font-weight:600}
.direct{margin-left:auto;background:#25d366;color:#111;border:0;border-radius:999px;padding:9px 16px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap}
.cap{padding:13px 16px 20px}
.t{font-weight:700;font-size:15px}
.p{font-size:15px;font-weight:700;margin-top:6px}
.a{color:var(--muted);font-size:13px;margin-top:2px}
.s{font-size:13px;margin-top:8px}
.desc{font-size:13px;color:var(--desc);margin-top:8px;white-space:pre-line;line-height:1.6}
.hint{margin-top:12px;color:var(--hint);font-size:12px;text-align:center}
.fav-list-wrap{padding:16px;background:var(--shell)}
.fav-title{font-weight:700;font-size:18px;margin-bottom:12px}
.fav-item{display:flex;gap:12px;border:1px solid var(--border);border-radius:12px;padding:8px;background:var(--surface);margin-bottom:10px;align-items:center}
.fav-item img{width:90px;height:112px;object-fit:contain;background:var(--softer);border-radius:8px}
.price{font-weight:700;margin-top:4px}
.fav-remove{border:0;background:var(--softer);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;margin-top:6px}
.fav-back{border:1px solid var(--text);background:var(--surface);color:var(--text);border-radius:999px;padding:10px 24px;margin-top:16px;cursor:pointer;font-weight:600}
.empty{padding:60px 24px;text-align:center;color:var(--muted)}
.empty b{display:block;font-size:18px;color:var(--text);margin-bottom:8px}
.hint-load{padding:80px 16px;text-align:center;color:var(--muted)}
</style>"""
src = src[:i] + css + src[j + len("</style>"):]

# C) insert theme strip right after .shell opening
old = '<div class="shell">\n  <div class="top">'
new = '<div class="shell">\n  <button class="theme-strip" id="themeToggle" aria-label="Переключить тему">Тема: БЕЛАЯ</button>\n  <div class="top">'
assert src.count(old) == 1
src = src.replace(old, new)

# D) main script: theme cycling
old = "const CAT_LABEL = "
new = """const THEMES = ['light', 'gray', 'dark'];
const THEME_LABEL = { light: 'Тема: БЕЛАЯ', gray: 'Тема: СЕРАЯ', dark: 'Тема: ЧЁРНАЯ' };
const THEME_COLOR = { light: '#ffffff', gray: '#d8d8dc', dark: '#000000' };
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = THEME_LABEL[t] || THEME_LABEL.light;
  try { localStorage.setItem('dh-theme', t); } catch (e) {}
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', THEME_COLOR[t] || '#ffffff');
}
{
  const initial = document.documentElement.dataset.theme || 'light';
  document.getElementById('themeToggle').onclick = () => {
    const i = THEMES.indexOf(document.documentElement.dataset.theme || 'light');
    applyTheme(THEMES[(i + 1) % THEMES.length]);
  };
  applyTheme(initial);
}
const CAT_LABEL = """
assert src.count(old) == 1
src = src.replace(old, new)

open("index.html", "w", encoding="utf-8").write(src)
print("theme toggle added")
