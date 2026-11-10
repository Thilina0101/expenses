/* Expense tracker: the app. Rules in core.js, receipt photos in store.js, texts in i18n.js. */
(function () {
  'use strict';
  const X = window.EX, S = window.ReceiptStore, t = I18N.t;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------------------------------------------------------- storage */
  function load() { try { return JSON.parse(localStorage.getItem(X.DB_KEY)); } catch { return null; } }
  let db = X.migrate(load());
  function save() {
    try { localStorage.setItem(X.DB_KEY, JSON.stringify(db)); }
    catch { toast(t('storageFull'), 8000); }
  }
  window.addEventListener('storage', (e) => { if (e.key === X.DB_KEY) { db = X.migrate(load()); applyLang(); renderAll(); } });
  // Ask the browser not to clear our data when the disk gets full (photos matter).
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }

  function act(fn, okMsg) {
    try { const r = fn(); save(); renderAll(); if (okMsg) toast(okMsg); return r ?? true; }
    catch (e) { if (e instanceof X.ExpenseError) { toast('⚠ ' + e.message, 5000); return null; } throw e; }
  }

  /* ---------------------------------------------------------------- UI helpers */
  let toastTimer;
  function toast(text, ms = 2800) { const el = $('toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms); }
  let onClose = null;
  function openModal(html, close) { const prev = onClose; onClose = null; prev?.(); $('mBody').innerHTML = html; $('modal').hidden = false; onClose = close || null; I18N.apply($('mBody')); }
  function closeModal() { $('modal').hidden = true; $('mBody').innerHTML = ''; const f = onClose; onClose = null; f?.(); }
  $('mClose').onclick = closeModal;
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  const today = () => X.dateStr(Date.now());
  const loc = () => I18N.locale();
  const money = (n) => { const v = Number(n) || 0; return db.settings.currency + v.toLocaleString(loc(), { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
  const fmtDate = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00').toLocaleDateString(loc(), o);
  const fmtMonth = (ym) => new Date(ym + '-15T12:00:00').toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
  const cat = (id) => db.categories.find((c) => c.id === id) || { name: '?', icon: '📌', color: '#78716c' };
  /** Built-in categories (still with their original English name) are shown in the chosen language. */
  const cname = (c) => (X.DEFAULT_NAMES[c.id] === c.name ? t('cat_' + c.id) : c.name);
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------------------------------------------------------------- receipt images */
  const urlCache = new Map();          // receipt id → object URL
  async function receiptUrl(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const r = await S.get(id);
    if (!r) return null;
    const u = URL.createObjectURL(r.blob);
    urlCache.set(id, u);
    return u;
  }
  function dropUrl(id) { const u = urlCache.get(id); if (u) URL.revokeObjectURL(u); urlCache.delete(id); }
  /** Fill <img data-rid> / [data-rid-pdf] placeholders after rendering. */
  async function hydrateThumbs(root = document) {
    for (const el of root.querySelectorAll('[data-rid]:not([data-done])')) {
      el.dataset.done = '1';
      const rec = await S.get(el.dataset.rid);
      if (!rec) { el.replaceWith(Object.assign(document.createElement('span'), { className: 'thumb missing', textContent: '?' })); continue; }
      if (rec.type === 'application/pdf') el.replaceWith(Object.assign(document.createElement('span'), { className: el.className + ' pdf', textContent: 'PDF' }));
      else el.src = await receiptUrl(el.dataset.rid);
    }
  }
  /** Phone photos are big: shrink to 1800 px and save as JPEG. PDFs are kept as they are. */
  async function prepareFile(file) {
    if (file.type === 'application/pdf') {
      if (file.size > 8 * 1024 * 1024) throw new Error(t('e_tooBig'));
      return file;
    }
    if (!file.type.startsWith('image/')) throw new Error(t('e_fileType'));
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      try {
        bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
      } catch { throw new Error(t('e_heic')); }
    }
    const max = 1800, w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.82));
  }
  async function rotateReceipt(id) {
    const rec = await S.get(id);
    if (!rec || !rec.type.startsWith('image/')) return;
    const bmp = await createImageBitmap(rec.blob);
    const c = document.createElement('canvas'); c.width = bmp.height; c.height = bmp.width;
    const g = c.getContext('2d'); g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    await S.put(blob, rec.name, id); dropUrl(id);
  }
  const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

  /* ---------------------------------------------------------------- AI receipt reading (needs server.mjs) */
  let ai = { checked: false, on: false };
  async function checkAi() {
    if (location.protocol === 'file:') { ai = { checked: true, on: false, reason: 'file' }; return ai; }
    try { const r = await fetch('api/status', { cache: 'no-store' }); const j = await r.json(); ai = { checked: true, on: !!j.ai, reason: j.ai ? '' : 'nokey' }; }
    catch { ai = { checked: true, on: false, reason: 'noserver' }; }
    return ai;
  }
  /** Claude is used when the server has a key, unless Settings says to always use the free reader. */
  const useClaude = () => ai.on && db.settings.reader !== 'free';
  async function readReceipt(id, onProgress) {
    const rec = await S.get(id);
    if (!rec) throw new Error(t('e_noPhoto'));
    if (!useClaude()) return readFree(rec, onProgress);
    const res = await fetch('api/receipt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: await blobToBase64(rec.blob), mediaType: rec.type, categories: db.categories.map(cname), today: today() }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || t('e_aiFailed'));
    return j.receipt;
  }

  /* ---------------------------------------------------------------- free reading on this device (Tesseract OCR) */
  const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let ocrWorker = null, ocrProgress = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error(t('e_ocrLoad'))); document.head.appendChild(el); });
  }
  async function getOcr() {
    if (!ocrWorker) {
      ocrWorker = (async () => {
        if (!window.Tesseract) await loadScript(TESSERACT);
        // English + Thai. The language files (a few MB) download once and are kept by the browser.
        return window.Tesseract.createWorker(['eng', 'tha'], 1, { logger: (m) => ocrProgress && ocrProgress(m) });
      })();
      ocrWorker.catch(() => { ocrWorker = null; });
    }
    return ocrWorker;
  }
  async function readFree(rec, onProgress) {
    if (!rec.type.startsWith('image/')) throw new Error(t('e_ocrPdf'));
    ocrProgress = onProgress;
    try {
      const worker = await getOcr();
      const { data } = await worker.recognize(rec.blob);
      return X.parseReceiptText(data.text, { today: today() });
    } finally { ocrProgress = null; }
  }

  /* ---------------------------------------------------------------- language, header, tabs */
  function applyLang() { I18N.setLang(db.settings.language); I18N.apply(); document.title = db.settings.name; }
  let tab = 'overview';
  try { tab = sessionStorage.getItem('ex_tab') || 'overview'; } catch { /* private mode */ }
  function showTab(name) {
    tab = name;
    try { sessionStorage.setItem('ex_tab', name); } catch { /* ignore */ }
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
    renderAll();
  }
  $('tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); };

  /* ================================================================ EXPENSE FORM */
  /** preset: an existing expense, or {receipts:[ids]} for a new one started from a photo. */
  function expenseForm(preset = {}) {
    const old = preset.id ? db.expenses.find((e) => e.id === preset.id) : null;
    const st = { receipts: [...(old ? old.receipts : preset.receipts || [])], added: [], category: old ? old.category : preset.category || '', method: old ? old.method : 'cash', ai: old ? old.ai : false, busy: false };
    const payees = [...new Set(db.expenses.slice().sort((a, b) => b.createdAt - a.createdAt).map((e) => e.payee).filter(Boolean))].slice(0, 200);
    openModal(`<h2>${old ? '✎ ' + esc(t('editExpense')) : '＋ ' + esc(t('addExpense'))}</h2>
      <div class="recbox" id="efRec"></div>
      <div id="efAi" class="aibox" hidden></div>
      <form id="efForm" autocomplete="off">
        <div class="grid2">
          <label><span>${esc(t('amount'))} (${esc(db.settings.currency)})</span><input id="efAmount" class="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${old ? old.amount : ''}" required></label>
          <label><span>${esc(t('date'))}</span><input id="efDate" type="date" value="${old ? old.date : today()}" required></label>
        </div>
        <div><span class="lbl">${esc(t('category'))}</span><div class="chips" id="efCats">${db.categories.map((c) => `<button type="button" class="chip" data-cat="${c.id}" style="--c:${esc(c.color)}">${esc(c.icon)} ${esc(cname(c))}</button>`).join('')}</div></div>
        <label><span>${esc(t('payee'))}</span><input id="efPayee" maxlength="100" list="payees" value="${esc(old?.payee)}" placeholder="${esc(t('payeePh'))}"></label>
        <datalist id="payees">${payees.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <div><span class="lbl">${esc(t('method'))}</span><div class="seg" id="efMethods">${X.METHODS.map((m) => `<button type="button" data-m="${m}">${esc(t('m_' + m))}</button>`).join('')}</div></div>
        <div class="grid2">
          <label><span>${esc(t('vat'))}</span><div class="inline"><input id="efVat" type="number" inputmode="decimal" step="0.01" min="0" value="${old && old.vat ? old.vat : ''}"><button type="button" class="btn small" id="efVatCalc">${esc(t('vatIncl', { r: db.settings.vatRate }))}</button></div></label>
          <label><span>${esc(t('note'))}</span><input id="efNote" maxlength="1000" value="${esc(old?.note)}"></label>
        </div>
        <div class="btnrow"><button class="btn primary big">${esc(t('save'))}</button>${old ? `<button type="button" class="btn danger" id="efDel">🗑 ${esc(t('delete'))}</button>` : ''}</div>
      </form>`, async () => {
      // closed without saving: delete photos that were added in this form
      if (!st.saved) for (const id of st.added) { await S.remove(id); dropUrl(id); }
    });

    const drawCats = () => document.querySelectorAll('#efCats .chip').forEach((b) => b.classList.toggle('on', b.dataset.cat === st.category));
    const drawMethod = () => document.querySelectorAll('#efMethods button').forEach((b) => b.classList.toggle('on', b.dataset.m === st.method));
    $('efCats').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { st.category = b.dataset.cat; b.classList.remove('ai'); drawCats(); } };
    $('efMethods').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { st.method = b.dataset.m; drawMethod(); } };
    $('efVatCalc').onclick = () => { const a = Number($('efAmount').value); if (a > 0) $('efVat').value = X.vatIncluded(a, db.settings.vatRate); };
    // remember the usual category for a payee
    $('efPayee').addEventListener('change', () => {
      if (st.category) return;
      const last = db.expenses.slice().sort((a, b) => b.createdAt - a.createdAt).find((e) => e.payee.toLowerCase() === $('efPayee').value.trim().toLowerCase());
      if (last) { st.category = last.category; st.method = last.method; drawCats(); drawMethod(); }
    });
    // fields the user has typed in are never overwritten by the AI
    ['efAmount', 'efDate', 'efPayee', 'efVat', 'efNote'].forEach((id) => $(id).addEventListener('input', (e) => { $(id).classList.remove('ai'); if (e.isTrusted) $(id).dataset.touched = '1'; }));

    const drawRec = () => {
      $('efRec').innerHTML = st.receipts.map((id) => `<button type="button" class="recthumb" data-view="${id}"><img class="thumb big" data-rid="${id}" alt=""></button>`).join('')
        + `<label class="recadd">📷<span>${esc(st.receipts.length ? t('addPhoto') : t('addReceipt'))}</span><input type="file" id="efFile" accept="image/*,application/pdf" multiple hidden></label>`
        + (st.receipts.length ? `<button type="button" class="btn small" id="efRead">${useClaude() ? '✨' : '📝'} ${esc(t(useClaude() ? 'readReceipt' : 'readFree'))}</button>` : '');
      hydrateThumbs($('efRec'));
      $('efFile').onchange = async (e) => { await addFiles([...e.target.files]); e.target.value = ''; };
      if ($('efRead')) $('efRead').onclick = () => runAi(st.receipts[0], true);
    };
    $('efRec').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) viewReceipt(b.dataset.view, st, drawRec); });
    async function addFiles(files) {
      const first = !st.receipts.length;
      for (const f of files.slice(0, 10 - st.receipts.length)) {
        try { const blob = await prepareFile(f); const id = await S.put(blob, f.name); st.receipts.push(id); st.added.push(id); }
        catch (err) { toast('⚠ ' + err.message, 5000); }
      }
      drawRec();
      if (first && st.receipts.length && db.settings.aiAuto && !$('efAmount').value) runAi(st.receipts[0], false);
    }
    async function runAi(id, manual) {
      if (st.busy) return;
      st.busy = true;
      const box = $('efAi'); box.hidden = false; box.className = 'aibox busy'; box.textContent = (useClaude() ? '✨ ' : '📝 ') + t('reading');
      const progress = (m) => {
        if (!$('efAi')) return;
        const pct = Math.round((m.progress || 0) * 100);
        box.textContent = '📝 ' + (m.status === 'recognizing text' ? t('ocrReading', { p: pct }) : t('ocrLoading'));
      };
      try {
        const r = await readReceipt(id, progress);
        if (!$('efForm')) return;                 // form was closed meanwhile
        if (!r.is_receipt) { box.className = 'aibox warn'; box.textContent = '⚠ ' + t(r.free ? 'freeNothing' : 'notReceipt'); return; }
        const fill = (el, v) => { if (v && (manual || (!old && !$(el).dataset.touched) || !$(el).value)) { $(el).value = v; $(el).classList.add('ai'); } };
        fill('efAmount', r.total || ''); fill('efDate', r.date && r.date <= today() ? r.date : ''); fill('efPayee', r.merchant); fill('efVat', r.vat || '');
        if (!$('efNote').value && !$('efNote').dataset.touched && r.items.length) { $('efNote').value = r.items.map((i) => i.name).join(', ').slice(0, 200); $('efNote').classList.add('ai'); }
        const usual = r.merchant && db.expenses.slice().sort((a, b) => b.createdAt - a.createdAt).find((e) => e.payee.toLowerCase() === r.merchant.toLowerCase());
        const c = r.free ? (usual?.category || (db.categories.some((x) => x.id === r.category) ? r.category : ''))
          : (db.categories.find((x) => cname(x) === r.category) || {}).id || X.matchCategory(db, r.category);
        if (c && (manual || !st.category)) { st.category = c; drawCats(); document.querySelector(`#efCats [data-cat="${c}"]`)?.classList.add('ai'); }
        if (r.payment_method !== 'unknown' && X.METHODS.includes(r.payment_method)) { st.method = r.payment_method; drawMethod(); }
        st.ai = true;
        const cur = r.currency && db.settings.currency === '฿' && r.currency !== 'THB' ? ' ' + t('otherCurrency', { c: r.currency }) : '';
        box.className = 'aibox ' + (r.confidence === 'high' ? 'ok' : 'warn');
        if (r.free) { box.innerHTML = `📝 ${esc(t('freeFilled'))} <b>${esc(t('conf_' + r.confidence))}</b>`; return; }
        box.innerHTML = `✨ ${esc(t('aiFilled'))} <b>${esc(t('conf_' + r.confidence))}</b>${r.notes ? ' · ' + esc(r.notes) : ''}${esc(cur)}${r.date && r.date > today() ? ' · ' + esc(t('aiFutureDate', { d: r.date })) : ''}`;
      } catch (err) {
        if ($('efAi')) { box.className = 'aibox warn'; box.textContent = '⚠ ' + err.message; }
      } finally { st.busy = false; }
    }

    $('efForm').onsubmit = (e) => {
      e.preventDefault();
      if (!st.category) { toast('⚠ ' + t('e_category'), 4000); return; }
      const input = { id: old?.id, date: $('efDate').value, amount: $('efAmount').value, vat: $('efVat').value, category: st.category, payee: $('efPayee').value, method: st.method, note: $('efNote').value, receipts: st.receipts, ai: st.ai };
      const dup = X.findDuplicate(db, input);
      if (dup && !confirm(t('dupWarn', { payee: dup.payee || '?', amount: money(dup.amount), date: fmtDate(dup.date) }))) return;
      const removed = old ? old.receipts.filter((r) => !st.receipts.includes(r)) : [];
      if (act(() => X.saveExpense(db, input), t('saved'))) {
        st.saved = true;
        removed.forEach(async (id) => { await S.remove(id); dropUrl(id); });
        closeModal();
      }
    };
    if (old) $('efDel').onclick = async () => {
      if (!confirm(t('confirmDelete'))) return;
      const ids = act(() => X.removeExpense(db, old.id), t('deleted'));
      if (ids) { st.saved = true; for (const id of ids) { await S.remove(id); dropUrl(id); } closeModal(); }
    };
    drawCats(); drawMethod(); drawRec();
    if (!old && !st.receipts.length) setTimeout(() => $('efAmount')?.focus(), 30);
    return { addFiles, runAi: () => st.receipts[0] && db.settings.aiAuto && !$('efAmount').value && runAi(st.receipts[0], false) };
  }

  /** Full-size receipt with rotate / download / remove. */
  async function viewReceipt(id, st, redraw) {
    const rec = await S.get(id); if (!rec) return;
    const url = await receiptUrl(id);
    const layer = document.createElement('div');
    layer.className = 'viewer';
    layer.innerHTML = `<div class="vbar"><button class="btn" data-v="close">✕</button>${rec.type.startsWith('image/') ? `<button class="btn" data-v="rotate">⟳ ${esc(t('rotate'))}</button>` : ''}
      <button class="btn" data-v="download">⬇ ${esc(t('download'))}</button>${st ? `<button class="btn danger" data-v="remove">🗑 ${esc(t('removePhoto'))}</button>` : ''}</div>
      <div class="vbody">${rec.type === 'application/pdf' ? `<iframe src="${url}" title="PDF"></iframe>` : `<img src="${url}" alt="" class="fit">`}</div>`;
    document.body.appendChild(layer);
    layer.addEventListener('click', async (e) => {
      const img = e.target.closest('img'); if (img) { img.classList.toggle('fit'); return; }
      const b = e.target.closest('[data-v]'); if (!b) return;
      if (b.dataset.v === 'close') layer.remove();
      if (b.dataset.v === 'download') download(rec.name || `receipt.${rec.type === 'application/pdf' ? 'pdf' : 'jpg'}`, rec.blob);
      if (b.dataset.v === 'rotate') { await rotateReceipt(id); layer.remove(); document.querySelectorAll(`[data-rid="${id}"]`).forEach((x) => { delete x.dataset.done; }); hydrateThumbs(); viewReceipt(id, st, redraw); renderAll(); }
      if (b.dataset.v === 'remove') { st.receipts = st.receipts.filter((r) => r !== id); layer.remove(); redraw(); }
    });
  }

  /* ---------------------------------------------------------------- snapping a receipt / dropping or pasting files */
  let currentForm = null;
  const newForm = (preset = {}) => { currentForm = expenseForm(preset); return currentForm; };
  const formOpen = () => !$('modal').hidden && !!$('efForm');
  async function takeFiles(files) {
    files = files.filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!files.length) return;
    if (!formOpen() || !currentForm) newForm({});
    await currentForm.addFiles(files);
  }
  $('snap').onchange = async (e) => { const files = [...e.target.files]; e.target.value = ''; newForm({}); await takeFiles(files); };
  $('addBtn').onclick = () => newForm({});
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('drop').hidden = true; takeFiles([...e.dataTransfer.files]); });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !document.activeElement?.matches('textarea')) { e.preventDefault(); takeFiles(files); }
  });

  /* ================================================================ OVERVIEW */
  let ovMonth = today().slice(0, 7);
  function renderOverview() {
    $('ovMonth').textContent = fmtMonth(ovMonth);
    const m = X.monthSummary(db, ovMonth);
    $('ovTotal').textContent = money(m.total);
    $('ovCompare').innerHTML = m.prevTotal ? esc(t('vsLast', { v: money(m.prevTotal) })) + ` <b class="${m.change > 0 ? 'up' : 'down'}">${m.change > 0 ? '▲' : '▼'} ${Math.abs(m.change)}%</b>` : esc(t('countN', { n: m.count }));
    $('ovBudget').innerHTML = m.budget ? `<div class="bb"><i style="width:${Math.min(100, m.budgetPct)}%" class="${m.budgetPct > 100 ? 'over' : m.budgetPct > 85 ? 'near' : ''}"></i></div><small>${esc(t('ofBudget', { s: money(m.budgetSpent), p: m.budgetPct, b: money(m.budget) }))}</small>` : `<small>${esc(t('noBudget'))}</small>`;
    // monthly bills due (only for the current month)
    const due = ovMonth === today().slice(0, 7) ? X.recurringDue(db) : [];
    $('ovDue').innerHTML = due.map((r) => `<div class="alert due"><span>🔁 <b>${esc(r.payee || cname(cat(r.category)))}</b> · ${esc(money(r.amount))} · ${esc(t('dueOn', { d: r.day }))}</span>
      <span class="btnrow"><input type="number" class="dueAmt" data-id="${r.id}" value="${r.amount}" step="0.01"><button class="btn small primary" data-act="addBill" data-id="${r.id}">＋ ${esc(t('add'))}</button><button class="btn small ghost" data-act="skipBill" data-id="${r.id}">${esc(t('skipMonth'))}</button></span></div>`).join('');
    const alerts = [];
    if (m.overBudget.length) alerts.push(`<div class="alert">⚠ ${esc(t('overBudget'))}: ${m.overBudget.map((c) => `<b>${esc(c.icon)} ${esc(cname(c))}</b> ${c.pct}%`).join(', ')}</div>`);
    if (m.missingReceipts) alerts.push(`<div class="alert info"><button class="link" data-act="showMissing">📎 ${esc(t('missingReceipts', { n: m.missingReceipts }))}</button></div>`);
    $('ovAlerts').innerHTML = alerts.join('');
    const maxCat = Math.max(1, ...m.categories.map((c) => Math.max(c.spent, c.budget || 0)));
    $('ovCats').innerHTML = m.categories.map((c) => `<button class="catbar" data-act="filterCat" data-id="${c.id}">
      <span class="ci">${esc(c.icon)}</span><span class="cn">${esc(cname(c))}<small>${c.budget ? esc(t('ofBudgetShort', { b: money(c.budget) })) : ''}${c.prev ? ' · ' + esc(t('lastMonthV', { v: money(c.prev) })) : ''}</small></span>
      <b class="${c.pct > 100 ? 'over' : ''}">${esc(money(c.spent))}</b>
      <span class="track"><i style="width:${c.spent / maxCat * 100}%;background:${esc(c.color)}"></i>${c.budget ? `<em style="left:${c.budget / maxCat * 100}%"></em>` : ''}</span></button>`).join('') || `<p class="muted">${esc(t('nothingYet'))}</p>`;
    const maxDay = Math.max(1, ...m.byDay);
    const td = today();
    $('ovDays').innerHTML = m.byDay.map((v, i) => { const d = `${ovMonth}-${String(i + 1).padStart(2, '0')}`; return `<div class="dbar${d === td ? ' today' : ''}" title="${esc(fmtDate(d))}: ${esc(money(v))}"><i style="height:${v / maxDay * 100}%"></i><small>${i + 1}</small></div>`; }).join('');
    const tr = X.trend(db, ovMonth, 6), maxT = Math.max(1, ...tr.map((x) => x.total));
    $('ovTrend').innerHTML = tr.map((x) => `<button class="tbar${x.month === ovMonth ? ' on' : ''}" data-act="month" data-m="${x.month}"><span>${esc(money(x.total))}</span><i style="height:${x.total / maxT * 100}%"></i><small>${esc(new Date(x.month + '-15T12:00:00').toLocaleDateString(loc(), { month: 'short' }))}</small></button>`).join('');
    $('ovBig').innerHTML = m.biggest.map(rowHtml).join('') || `<p class="muted">${esc(t('nothingYet'))}</p>`;
    hydrateThumbs($('ovBig'));
  }
  $('ovPrev').onclick = () => { ovMonth = X.addMonths(ovMonth, -1); renderOverview(); };
  $('ovNext').onclick = () => { ovMonth = X.addMonths(ovMonth, 1); renderOverview(); };

  /* ================================================================ LIST */
  const filt = { month: today().slice(0, 7), category: '', method: '', q: '', noReceipt: false };
  function rowHtml(e) {
    const c = cat(e.category);
    return `<button class="erow" data-act="edit" data-id="${e.id}"><span class="ci" style="background:${esc(c.color)}22">${esc(c.icon)}</span>
      <span class="en"><b>${esc(e.payee || cname(c))}</b><small>${esc(cname(c))} · ${esc(t('m_' + e.method))}${e.note ? ' · ' + esc(e.note) : ''}</small></span>
      ${e.receipts.length ? `<img class="thumb" data-rid="${e.receipts[0]}" alt="">` : `<span class="thumb none" title="${esc(t('noReceipt'))}">📎</span>`}
      <b class="amt">${esc(money(e.amount))}</b></button>`;
  }
  function currentList() {
    const range = filt.month ? { from: filt.month + '-01', to: filt.month + '-31' } : {};
    return X.filterExpenses(db, { ...range, category: filt.category, method: filt.method, q: filt.q, noReceipt: filt.noReceipt });
  }
  function renderList() {
    const months = [...new Set([today().slice(0, 7), ...db.expenses.map((e) => e.date.slice(0, 7))])].sort().reverse();
    $('fMonth').innerHTML = `<option value="">${esc(t('allMonths'))}</option>` + months.map((m) => `<option value="${m}">${esc(fmtMonth(m))}</option>`).join('');
    $('fMonth').value = filt.month;
    $('fCat').innerHTML = `<option value="">${esc(t('allCategories'))}</option>` + db.categories.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(cname(c))}</option>`).join('');
    $('fCat').value = filt.category;
    $('fMethod').innerHTML = `<option value="">${esc(t('allMethods'))}</option>` + X.METHODS.map((m) => `<option value="${m}">${esc(t('m_' + m))}</option>`).join('');
    $('fMethod').value = filt.method;
    $('fNoRec').checked = filt.noReceipt;
    const list = currentList();
    $('fTotal').textContent = t('listTotal', { n: list.length, v: money(list.reduce((s, e) => s + e.amount, 0)) });
    const byDate = {};
    for (const e of list) (byDate[e.date] ||= []).push(e);
    $('list').innerHTML = Object.entries(byDate).map(([d, es]) => `<div class="dgroup"><div class="dhead"><b>${esc(fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' }))}</b><span>${esc(money(es.reduce((s, e) => s + e.amount, 0)))}</span></div>${es.map(rowHtml).join('')}</div>`).join('')
      || `<div class="empty"><p>${esc(db.expenses.length ? t('noMatch') : t('emptyHelp'))}</p></div>`;
    hydrateThumbs($('list'));
  }
  $('fMonth').onchange = () => { filt.month = $('fMonth').value; renderList(); };
  $('fCat').onchange = () => { filt.category = $('fCat').value; renderList(); };
  $('fMethod').onchange = () => { filt.method = $('fMethod').value; renderList(); };
  $('fQ').oninput = () => { filt.q = $('fQ').value; renderList(); };
  $('fNoRec').onchange = () => { filt.noReceipt = $('fNoRec').checked; renderList(); };
  const exportName = () => `expenses-${filt.month || 'all'}${filt.category ? '-' + cat(filt.category).name.replace(/\W+/g, '') : ''}`;
  $('exCsv').onclick = () => download(exportName() + '.csv', new Blob([X.expensesCsv(db, currentList(), () => [], cname)], { type: 'text/csv;charset=utf-8' }));
  $('exZip').onclick = async () => {
    if (!window.JSZip) { toast('⚠ ' + t('e_zipOffline'), 6000); return; }
    const list = currentList();
    const zip = new JSZip(), names = new Map();
    let n = 0;
    for (const e of list) {
      const ns = [];
      for (const [i, id] of e.receipts.entries()) {
        const rec = await S.get(id); if (!rec) continue;
        const name = X.receiptFileName(e, i, rec.type === 'application/pdf' ? 'pdf' : 'jpg');
        zip.file('receipts/' + name, rec.blob); ns.push(name); n++;
      }
      names.set(e.id, ns);
    }
    zip.file(exportName() + '.csv', X.expensesCsv(db, list, (e) => names.get(e.id) || [], cname));
    download(exportName() + '.zip', await zip.generateAsync({ type: 'blob' }));
    toast(t('zipDone', { n: list.length, r: n }));
  };

  /* ================================================================ SETTINGS */
  function renderSettings() {
    const s = db.settings;
    if (!$('setForm').contains(document.activeElement)) {
      $('sName').value = s.name;
      $('sLang').innerHTML = I18N.LANGS.map((l) => `<option value="${l}">${I18N.LANG_NAMES[l]}</option>`).join(''); $('sLang').value = s.language;
      $('sCur').value = s.currency; $('sVat').value = s.vatRate; $('sAi').checked = s.aiAuto; $('sReader').value = s.reader === 'free' ? 'free' : 'auto'; $('sPin').value = s.pin;
    }
    $('aiStatus').textContent = !ai.checked ? '' : useClaude() ? '✨ ' + t('aiOn') : '📝 ' + t('freeOn') + (ai.on ? '' : ' ' + t('aiOff_' + ai.reason));
    $('catList').innerHTML = db.categories.map((c) => `<div class="catrow" data-id="${c.id}">
      <input class="cIcon" value="${esc(c.icon)}" maxlength="4"><input class="cName" value="${esc(cname(c))}" maxlength="40">
      <input class="cColor" type="color" value="${esc(c.color)}"><input class="cBudget" type="number" min="0" step="100" value="${c.budget || ''}" placeholder="${esc(t('budget'))}">
      <button class="btn small ghost" data-act="rmCat" data-id="${c.id}">✕</button></div>`).join('');
    $('billList').innerHTML = db.recurring.map((r) => `<button class="erow" data-act="editBill" data-id="${r.id}"><span class="ci">${esc(cat(r.category).icon)}</span>
      <span class="en"><b>${esc(r.payee || cname(cat(r.category)))}</b><small>${esc(t('everyMonthOn', { d: r.day }))} · ${esc(t('m_' + r.method))}${r.active ? '' : ' · ' + esc(t('paused'))}</small></span><b class="amt">${esc(money(r.amount))}</b></button>`).join('') || `<p class="muted">${esc(t('nothingYet'))}</p>`;
    (async () => {
      let used = '';
      try { const est = await navigator.storage.estimate(); used = t('storageUsed', { mb: (est.usage / 1048576).toFixed(1) }); } catch { /* not supported */ }
      const nRec = db.expenses.reduce((s2, e) => s2 + e.receipts.length, 0);
      $('dataInfo').textContent = t('dataInfo', { e: db.expenses.length, r: nRec }) + ' ' + used;
    })();
  }
  $('catList').addEventListener('change', (e) => {
    const row = e.target.closest('.catrow'); if (!row) return;
    const c0 = cat(row.dataset.id), typed = row.querySelector('.cName').value.trim();
    act(() => X.saveCategory(db, { id: row.dataset.id, icon: row.querySelector('.cIcon').value, name: typed === cname(c0) ? c0.name : typed, color: row.querySelector('.cColor').value, budget: row.querySelector('.cBudget').value }), t('saved'));
  });
  $('catAdd').onclick = () => { act(() => X.saveCategory(db, { name: t('newCategory') + ' ' + (db.categories.length + 1), icon: '📌', color: '#0f766e' })); };
  $('setForm').onsubmit = (e) => {
    e.preventDefault();
    const pin = $('sPin').value.trim();
    if (pin && !/^\d{4,8}$/.test(pin)) { toast('⚠ ' + t('e_pin'), 4000); return; }
    Object.assign(db.settings, { name: $('sName').value.trim() || 'Expenses', language: $('sLang').value, currency: $('sCur').value.trim() || '฿',
      vatRate: Math.min(50, Math.max(0, Number($('sVat').value) || 0)), aiAuto: $('sAi').checked, reader: $('sReader').value, pin });
    if (pin) try { sessionStorage.setItem('ex_unlocked', '1'); } catch { /* ignore */ }
    save(); document.activeElement.blur(); applyLang(); renderAll(); toast(t('saved'));
  };
  $('sLang').onchange = () => { db.settings.language = $('sLang').value; save(); applyLang(); document.activeElement.blur(); renderAll(); };

  function billForm(r) {
    r = r || { payee: '', amount: '', category: db.categories[0].id, method: 'transfer', day: 1, note: '', active: true };
    openModal(`<h2>🔁 ${esc(r.id ? r.payee || t('bill') : t('addBill'))}</h2>
      <form id="bfForm">
        <label><span>${esc(t('payee'))}</span><input id="blPayee" maxlength="100" value="${esc(r.payee)}" placeholder="${esc(t('billPh'))}"></label>
        <div class="grid3">
          <label><span>${esc(t('amount'))}</span><input id="blAmount" type="number" step="0.01" min="0" value="${r.amount}" required></label>
          <label><span>${esc(t('dayOfMonth'))}</span><input id="blDay" type="number" min="1" max="28" value="${r.day}"></label>
          <label><span>${esc(t('method'))}</span><select id="blMethod">${X.METHODS.map((m) => `<option value="${m}" ${m === r.method ? 'selected' : ''}>${esc(t('m_' + m))}</option>`).join('')}</select></label>
        </div>
        <label><span>${esc(t('category'))}</span><select id="blCat">${db.categories.map((c) => `<option value="${c.id}" ${c.id === r.category ? 'selected' : ''}>${esc(c.icon)} ${esc(cname(c))}</option>`).join('')}</select></label>
        <label><span>${esc(t('note'))}</span><input id="blNote" maxlength="200" value="${esc(r.note)}"></label>
        <label class="check"><input type="checkbox" id="blActive" ${r.active ? 'checked' : ''}> ${esc(t('billActive'))}</label>
        <div class="btnrow"><button class="btn primary big">${esc(t('save'))}</button>${r.id ? `<button type="button" class="btn danger" id="blDel">${esc(t('delete'))}</button>` : ''}</div>
      </form>`);
    $('bfForm').onsubmit = (e) => {
      e.preventDefault();
      if (act(() => X.saveRecurring(db, { id: r.id, payee: $('blPayee').value, amount: $('blAmount').value, day: $('blDay').value, method: $('blMethod').value, category: $('blCat').value, note: $('blNote').value, active: $('blActive').checked }), t('saved'))) closeModal();
    };
    if (r.id) $('blDel').onclick = () => { if (confirm(t('confirmDelete')) && act(() => X.removeRecurring(db, r.id), t('deleted'))) closeModal(); };
  }
  $('billAdd').onclick = () => billForm(null);

  /* ---------------------------------------------------------------- backup / restore (ZIP with photos) */
  $('bkExport').onclick = async () => {
    if (!window.JSZip) { download(`expenses-backup-${today()}.json`, new Blob([X.exportData(db)], { type: 'application/json' })); toast(t('backupNoPhotos'), 6000); return; }
    const zip = new JSZip();
    zip.file('data.json', X.exportData(db));
    let n = 0;
    for (const id of await S.ids()) { const rec = await S.get(id); zip.file(`receipts/${id}`, rec.blob, { comment: JSON.stringify({ type: rec.type, name: rec.name }) }); n++; }
    zip.file('receipts.json', JSON.stringify(await Promise.all((await S.ids()).map(async (id) => { const r = await S.get(id); return { id, type: r.type, name: r.name }; }))));
    download(`expenses-backup-${today()}.zip`, await zip.generateAsync({ type: 'blob' }));
    toast(t('backupDone', { n }));
  };
  $('bkImport').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      let next, photos = [];
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
        if (!window.JSZip) throw new Error(t('e_zipOffline'));
        const zip = await JSZip.loadAsync(f);
        const data = zip.file('data.json'); if (!data) throw new Error(t('e_backup'));
        next = X.importData(await data.async('string'));
        const meta = JSON.parse(await zip.file('receipts.json')?.async('string') || '[]');
        photos = meta.map((m) => ({ ...m, file: zip.file('receipts/' + m.id) })).filter((m) => m.file);
      } else next = X.importData(await f.text());
      if (!confirm(t('confirmRestore', { e: next.expenses.length, r: photos.length }))) return;
      await S.clear(); urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
      for (const p of photos) await S.put(new Blob([await p.file.async('arraybuffer')], { type: p.type }), p.name, p.id);
      db = next; save(); applyLang(); renderAll(); toast(t('restored'));
    } catch (err) { toast('⚠ ' + (err instanceof X.ExpenseError ? err.message : t('e_backup')), 6000); }
  };
  $('bkErase').onclick = async () => {
    const word = t('eraseWord');
    if (prompt(t('confirmErase', { word })) !== word) return;
    await S.clear(); urlCache.clear();
    db = X.defaultsDb(); db.settings.language = I18N.lang; save(); applyLang(); renderAll(); toast(t('erased'));
  };

  /* ================================================================ clicks */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'edit': newForm(db.expenses.find((x) => x.id === id) || {}); break;
      case 'filterCat': Object.assign(filt, { month: ovMonth, category: id, method: '', q: '', noReceipt: false }); $('fQ').value = ''; showTab('list'); break;
      case 'showMissing': Object.assign(filt, { month: ovMonth, category: '', method: '', q: '', noReceipt: true }); $('fQ').value = ''; showTab('list'); break;
      case 'month': ovMonth = b.dataset.m; renderOverview(); break;
      case 'addBill': { const amt = document.querySelector(`.dueAmt[data-id="${id}"]`)?.value; act(() => X.addRecurring(db, id, Date.now(), amt), t('saved')); break; }
      case 'skipBill': act(() => X.skipRecurring(db, id)); break;
      case 'editBill': billForm(db.recurring.find((r) => r.id === id)); break;
      case 'rmCat': {
        const others = db.categories.filter((c) => c.id !== id);
        const used = db.expenses.filter((x) => x.category === id).length;
        const to = others.find((c) => c.id === 'c11') || others[others.length - 1];
        if (!to) { toast('⚠ ' + t('e_lastCat'), 4000); break; }
        if (confirm(used ? t('confirmRmCatUsed', { n: used, to: cname(to) }) : t('confirmRmCat'))) act(() => X.removeCategory(db, id, to.id), t('deleted'));
        break;
      }
    }
  });

  /* ================================================================ lock & start */
  function lockScreen() {
    if (!db.settings.pin) return;
    try { sessionStorage.removeItem('ex_unlocked'); } catch { /* ignore */ }
    $('lockName').textContent = db.settings.name; $('lockErr').textContent = ''; $('lockPin').value = '';
    $('lock').hidden = false; setTimeout(() => $('lockPin').focus(), 30);
  }
  $('lockBtn').onclick = lockScreen;
  $('lockForm').onsubmit = (e) => {
    e.preventDefault();
    if ($('lockPin').value === db.settings.pin) { $('lock').hidden = true; try { sessionStorage.setItem('ex_unlocked', '1'); } catch { /* ignore */ } }
    else { $('lockErr').textContent = t('wrongPin'); $('lockPin').value = ''; }
  };
  function renderAll() {
    $('appName').textContent = db.settings.name;
    $('lockBtn').hidden = !db.settings.pin;
    if (tab === 'overview') renderOverview();
    if (tab === 'list') renderList();
    if (tab === 'settings') renderSettings();
  }
  applyLang();
  showTab(tab);
  let unlocked = false; try { unlocked = sessionStorage.getItem('ex_unlocked') === '1'; } catch { /* ignore */ }
  if (db.settings.pin && !unlocked) lockScreen();
  checkAi().then(() => { if (tab === 'settings') renderSettings(); });
  window.__app = { get db() { return db; }, X, S, get ai() { return ai; } };
})();
