// Distill Local Dedupe：画面の動き（読み込み・重複のまとめ・中身の確認・ゴミ箱へ）
(() => {
  'use strict';
  const T = window.__TAURI__ || null;
  const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.reject(new Error('Tauri の中で開いてください')));
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (b) => (b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const LS_DIRS = 'dld:dirs:v1';
  const st = { dirs: [], files: [], groups: [], hash: new Map(), sel: new Set(), busy: false, q: '' };
  try { st.dirs = JSON.parse(localStorage.getItem(LS_DIRS) || '[]') || []; } catch (e) { st.dirs = []; }
  const status = (t) => { $('#status').textContent = t; };
  if (T && T.app) T.app.getVersion().then((v) => { $('#ver').textContent = 'v' + v; }).catch(() => {});

  // ---- まとめ方（PikPak Distill – Dedupe と同じルール） ----
  // 同じファイル名：大文字小文字と、重複回避の (1) などは同じとみなす。同じ品番：5〜8 桁の数字
  const keyOf = (name, mode) => (mode === 'id' ? ((name.match(/(\d{5,8})/) || [])[1] || name.toLowerCase()) : name.toLowerCase().replace(/\s?\(\d+\)(?=\.[a-z0-9]{2,5}$|$)/, ''));
  function buildGroups() {
    const mode = $('#mode').value, m = new Map();
    st.files.forEach((f) => { const k = keyOf(f.name, mode); if (!m.has(k)) m.set(k, []); m.get(k).push(f); });
    st.groups = [...m.entries()].filter(([, v]) => v.length > 1).map(([key, items]) => { items.sort((a, b) => b.size - a.size || a.mtime - b.mtime); return { key, items }; })
      .sort((a, b) => b.items[0].size - a.items[0].size);
    // 初めは各組の一番大きいもの（同じなら古いもの）を残し、それ以外にチェック
    st.sel = new Set(st.groups.flatMap((g) => g.items.slice(1).map((f) => f.path)));
  }

  // ---- 画面 ----
  function renderDirs() {
    $('#dirs').innerHTML = st.dirs.map((d, i) => `<span class="chip" title="${esc(d)}"><span>📁 ${esc(d)}</span><button data-rm="${i}" title="外す">✕</button></span>`).join('');
    $('#scan').disabled = !st.dirs.length || st.busy;
    try { localStorage.setItem(LS_DIRS, JSON.stringify(st.dirs)); } catch (e) { /* 無視 */ }
  }
  function sameTag(g) {
    if (!$('#verify').checked) return '';
    const hs = g.items.map((f) => st.hash.get(f.path));
    if (hs.some((h) => h === undefined)) return '<span class="tag">中身を確認中…</span>';
    if (hs.some((h) => h === null)) return '<span class="tag diff">中身を読めないファイルあり</span>';
    return new Set(hs).size === 1 ? '<span class="tag same">中身も完全に同じ</span>' : '<span class="tag diff">中身が違うものあり</span>';
  }
  function render() {
    const q = st.q.trim().toLowerCase();
    const gs = st.groups.filter((g) => !q || g.items.some((f) => (f.path).toLowerCase().includes(q)));
    if (!st.files.length) return;
    if (!gs.length) { $('#main').innerHTML = `<div class="empty"><b>重複は見つかりませんでした</b><span>${st.files.length} ファイルを調べました。まとめ方を「同じ品番」に変えると、名前が違う同じ作品も探せます。</span></div>`; $('#bar').hidden = true; return; }
    $('#main').innerHTML = gs.slice(0, 500).map((g) => {
      const max = g.items[0].size || 1;
      return `<div class="g"><div class="gh"><b>${esc(g.items[0].name)}</b><span class="tag">${g.items.length} 件</span>${sameTag(g)}</div>${g.items.map((f, i) => {
        const on = st.sel.has(f.path), ext = (f.name.match(/\.([a-z0-9]{1,5})$/i) || [, '—'])[1].toUpperCase();
        const diff = i ? `最大比 ${(((f.size - max) / max) * 100).toFixed(1)}%` : '最大＝残す候補';
        return `<div class="r ${on ? 'del' : i === 0 ? 'keep' : ''}"><input type="checkbox" data-p="${esc(f.path)}"${on ? ' checked' : ''}><span class="ext">${esc(ext)}</span><span class="t"><b>${esc(f.name)}</b><small title="${esc(f.dir)}">${esc(f.dir)}</small></span><span class="sz">${fmt(f.size)}<small>${diff}</small></span><button data-rv="${esc(f.path)}" title="Finder・エクスプローラーで場所を開く">場所を開く</button></div>`;
      }).join('')}</div>`;
    }).join('') + (gs.length > 500 ? `<div class="empty"><span>ほか ${gs.length - 500} 組（絞り込みで探せます）</span></div>` : '');
    const sel = st.files.filter((f) => st.sel.has(f.path));
    $('#sum').textContent = `重複 ${gs.length} 組 ／ チェック ${sel.length} 件・${fmt(sel.reduce((s, f) => s + f.size, 0))}（ゴミ箱へ移します）`;
    $('#bar').hidden = false; $('#trash').disabled = !sel.length || st.busy;
  }

  // ---- 読み込み → まとめ → 中身の確認 ----
  async function scan() {
    if (st.busy || !st.dirs.length) return;
    st.busy = true; renderDirs(); st.hash.clear();
    status('読み込んでいます…（ファイルは変更しません）');
    $('#main').innerHTML = '<div class="empty"><b>読み込んでいます…</b><span>フォルダが多いと少しかかります</span></div>';
    try {
      const t0 = Date.now();
      const r = await invoke('scan', { paths: st.dirs, minSize: +$('#min').value });
      st.files = r.files; buildGroups(); render();
      status(`読み込み完了：ファイル ${r.files.length} 件・フォルダ ${r.folders} 件（${((Date.now() - t0) / 1000).toFixed(1)} 秒）${r.skipped ? `・読めなかったもの ${r.skipped} 件` : ''}。重複 ${st.groups.length} 組`);
      if ($('#verify').checked) await verifyAll();
    } catch (e) { status('読み込めませんでした：' + (e.message || e)); }
    st.busy = false; renderDirs(); render();
  }
  async function verifyAll() {
    const todo = st.groups.flatMap((g) => g.items).filter((f) => !st.hash.has(f.path));
    let n = 0;
    for (const f of todo) {
      try { st.hash.set(f.path, await invoke('quick_hash', { path: f.path })); } catch (e) { st.hash.set(f.path, null); }
      if (++n % 10 === 0 || n === todo.length) { status(`中身を確かめています… ${n} / ${todo.length}`); render(); }
    }
    if (todo.length) status(`中身の確認が終わりました（${todo.length} ファイル）`);
  }

  // ---- ゴミ箱へ ----
  async function toTrash() {
    const list = st.files.filter((f) => st.sel.has(f.path));
    if (!list.length || st.busy) return;
    // 組のすべてをチェックしていないか確かめる（全部消すと何も残らない）
    const all = st.groups.filter((g) => g.items.every((f) => st.sel.has(f.path)));
    const msg = `${list.length} 件（${fmt(list.reduce((s, f) => s + f.size, 0))}）を ゴミ箱へ移します。` + (all.length ? `\n\n⚠ ${all.length} 組は、すべてにチェックが入っています（何も残りません）。` : '') + '\n\nゴミ箱から元に戻せます。よろしいですか？';
    const ok = T && T.dialog ? await T.dialog.ask(msg, { title: 'ゴミ箱へ移す', kind: 'warning', okLabel: 'ゴミ箱へ', cancelLabel: 'キャンセル' }) : confirm(msg);
    if (!ok) return;
    st.busy = true; render(); status('ゴミ箱へ移しています…');
    try {
      const r = await invoke('move_to_trash', { paths: list.map((f) => f.path) });
      const gone = new Set(r.ok);
      st.files = st.files.filter((f) => !gone.has(f.path)); gone.forEach((p) => st.sel.delete(p));
      buildGroups();
      status(`${r.ok.length} 件をゴミ箱へ移しました` + (r.failed.length ? `。移せなかったもの ${r.failed.length} 件：${r.failed.slice(0, 3).map(([p, e]) => p.split(/[\\/]/).pop() + '（' + e + '）').join('、')}` : ''));
    } catch (e) { status('ゴミ箱へ移せませんでした：' + (e.message || e)); }
    st.busy = false; render();
  }

  // ---- 操作 ----
  $('#add').onclick = async () => {
    if (!T) return status('Tauri の中で開いてください');
    const r = await T.dialog.open({ directory: true, multiple: true, title: '整理するフォルダを選ぶ' });
    (Array.isArray(r) ? r : r ? [r] : []).forEach((d) => { if (!st.dirs.includes(d)) st.dirs.push(d); });
    renderDirs();
  };
  $('#dirs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b && !st.busy) { st.dirs.splice(+b.dataset.rm, 1); renderDirs(); } };
  $('#scan').onclick = scan;
  $('#trash').onclick = toTrash;
  $('#mode').onchange = () => { if (st.files.length) { buildGroups(); render(); if ($('#verify').checked) verifyAll().then(render); } };
  $('#verify').onchange = () => { render(); if ($('#verify').checked && st.files.length) verifyAll().then(render); };
  $('#q').oninput = (e) => { st.q = e.target.value; render(); };
  $('#main').addEventListener('change', (e) => { const p = e.target.dataset.p; if (p === undefined) return; if (e.target.checked) st.sel.add(p); else st.sel.delete(p); render(); });
  $('#main').addEventListener('click', (e) => { const b = e.target.closest('[data-rv]'); if (b && T) T.opener.revealItemInDir(b.dataset.rv).catch((err) => status('開けませんでした：' + err)); });
  renderDirs();
})();
