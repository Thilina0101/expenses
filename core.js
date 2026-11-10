/* Expense tracker: business rules shared by the app and the tests. No user interface code here.
 * Expense records live in a plain "db" object (saved in localStorage); receipt photos live in IndexedDB (store.js).
 */
(function (root) {
  'use strict';
  const DB_KEY = 'expenses_v1';
  const METHODS = ['cash', 'card', 'transfer', 'promptpay', 'other'];

  const EN = {
    e_amount: 'Enter an amount above 0', e_date: 'Choose a valid date', e_future: 'That date is more than a year away',
    e_category: 'Choose a category', e_expense: 'Expense not found', e_catName: 'Category name is required',
    e_catUsed: 'There is already a category called {name}', e_lastCat: 'Keep at least one category', e_budget: 'Budget must be 0 or more',
    e_day: 'Day must be 1 to 28', e_recurring: 'Monthly bill not found', e_backup: 'This is not an expense tracker backup', e_vat: 'VAT can\'t be more than the amount',
  };
  function msg(key, vars) {
    if (root.I18N) return root.I18N.t(key, vars);
    return (EN[key] || key).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
  }
  class ExpenseError extends Error {}
  const fail = (key, vars) => { throw new ExpenseError(msg(key, vars)); };

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T12:00:00')) && dateStr(new Date(s + 'T12:00:00')) === s;
  const monthOf = (d) => d.slice(0, 7);
  const addMonths = (ym, n) => { const d = new Date(ym + '-15T12:00:00'); d.setMonth(d.getMonth() + n); return dateStr(d).slice(0, 7); };
  const daysInMonth = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  let seq = 0;
  const uid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
  const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const money = (n) => Math.round(Number(n) * 100) / 100;

  /* ---------------------------------------------------------------- database */
  const DEFAULT_CATS = [
    ['Ingredients & stock', '🥬', '#16a34a'], ['Rent', '🏠', '#7c3aed'], ['Electricity & water', '💡', '#eab308'], ['Wages', '👥', '#2563eb'],
    ['Equipment', '🔧', '#0891b2'], ['Packaging', '📦', '#a16207'], ['Marketing', '📣', '#db2777'], ['Transport & fuel', '⛽', '#ea580c'],
    ['Repairs', '🛠', '#64748b'], ['Fees & taxes', '🧾', '#dc2626'], ['Other', '📌', '#78716c'],
  ];
  const DEFAULT_NAMES = Object.fromEntries(DEFAULT_CATS.map(([name], i) => ['c' + (i + 1), name]));
  function defaultsDb() {
    return {
      v: 1,
      settings: { name: 'My expenses', language: 'en', currency: '฿', vatRate: 7, pin: '', aiAuto: true, reader: 'auto' },
      categories: DEFAULT_CATS.map(([name, icon, color], i) => ({ id: 'c' + (i + 1), name, icon, color, budget: 0 })),
      expenses: [], recurring: [],
    };
  }
  function migrate(db) {
    const d = defaultsDb();
    if (!db || typeof db !== 'object') return d;
    db.settings = { ...d.settings, ...(db.settings || {}) };
    if (!Array.isArray(db.categories) || !db.categories.length) db.categories = d.categories;
    for (const k of ['expenses', 'recurring']) if (!Array.isArray(db[k])) db[k] = [];
    for (const e of db.expenses) if (!Array.isArray(e.receipts)) e.receipts = [];
    db.v = 1;
    return db;
  }

  /* ---------------------------------------------------------------- expenses */
  function saveExpense(db, input, now = Date.now()) {
    const amount = money(input.amount);
    if (!(amount > 0) || amount > 1e10) fail('e_amount');
    const date = input.date;
    if (!validDate(date)) fail('e_date');
    if (date > dateStr(now + 366 * 864e5)) fail('e_future');
    if (!db.categories.some((c) => c.id === input.category)) fail('e_category');
    const vat = input.vat === '' || input.vat === undefined || input.vat === null ? 0 : money(input.vat);
    if (vat < 0 || vat > amount) fail('e_vat');
    const old = input.id ? db.expenses.find((e) => e.id === input.id) : null;
    if (input.id && !old) fail('e_expense');
    const e = {
      id: old ? old.id : uid(), date, amount, vat, category: input.category,
      payee: clean(input.payee, 100), method: METHODS.includes(input.method) ? input.method : 'cash',
      note: String(input.note || '').trim().slice(0, 1000), receipts: Array.isArray(input.receipts) ? input.receipts.slice(0, 10) : (old ? old.receipts : []),
      ai: !!input.ai, recurringId: input.recurringId || (old ? old.recurringId : null) || null,
      createdAt: old ? old.createdAt : now, updatedAt: now,
    };
    if (old) Object.assign(old, e); else db.expenses.push(e);
    return old || e;
  }
  /** Removes the expense and returns the receipt ids so the caller can delete the photos. */
  function removeExpense(db, id) {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail('e_expense');
    db.expenses = db.expenses.filter((x) => x.id !== id);
    return e.receipts.filter((r) => !db.expenses.some((x) => x.receipts.includes(r)));
  }
  /** Same day, same amount, same payee: probably entered twice. */
  function findDuplicate(db, { id, date, amount, payee }) {
    const p = clean(payee).toLowerCase();
    return db.expenses.find((e) => e.id !== id && e.date === date && e.amount === money(amount) && e.payee.toLowerCase() === p) || null;
  }
  function filterExpenses(db, { from, to, category, q, method, noReceipt } = {}) {
    q = clean(q).toLowerCase();
    const num = q.replace(/[^\d.]/g, '');
    return db.expenses.filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!category || e.category === category)
      && (!method || e.method === method) && (!noReceipt || !e.receipts.length)
      && (!q || e.payee.toLowerCase().includes(q) || e.note.toLowerCase().includes(q) || (num && String(e.amount).includes(num))))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }

  /* ---------------------------------------------------------------- summaries */
  function monthSummary(db, ym) {
    const list = db.expenses.filter((e) => monthOf(e.date) === ym);
    const prev = db.expenses.filter((e) => monthOf(e.date) === addMonths(ym, -1));
    const total = money(list.reduce((s, e) => s + e.amount, 0));
    const prevTotal = money(prev.reduce((s, e) => s + e.amount, 0));
    const byCat = {};
    for (const e of list) byCat[e.category] = money((byCat[e.category] || 0) + e.amount);
    const categories = db.categories.map((c) => ({
      ...c, spent: byCat[c.id] || 0, pct: c.budget > 0 ? Math.round((byCat[c.id] || 0) / c.budget * 100) : null,
      prev: money(prev.filter((e) => e.category === c.id).reduce((s, e) => s + e.amount, 0)),
    })).filter((c) => c.spent > 0 || c.budget > 0).sort((a, b) => b.spent - a.spent);
    const days = daysInMonth(ym);
    const byDay = Array.from({ length: days }, (_, i) => money(list.filter((e) => Number(e.date.slice(8)) === i + 1).reduce((s, e) => s + e.amount, 0)));
    // compare only the categories that have a budget (rent without a budget doesn't count against it)
    const budget = db.categories.reduce((s, c) => s + (c.budget || 0), 0);
    const budgetSpent = money(db.categories.filter((c) => c.budget > 0).reduce((s, c) => s + (byCat[c.id] || 0), 0));
    const byMethod = {};
    for (const e of list) byMethod[e.method] = money((byMethod[e.method] || 0) + e.amount);
    return {
      month: ym, total, prevTotal, change: prevTotal ? Math.round((total - prevTotal) / prevTotal * 100) : null,
      vat: money(list.reduce((s, e) => s + e.vat, 0)), count: list.length, missingReceipts: list.filter((e) => !e.receipts.length).length,
      budget, budgetSpent, budgetPct: budget ? Math.round(budgetSpent / budget * 100) : null, overBudget: categories.filter((c) => c.pct !== null && c.pct > 100),
      categories, byDay, byMethod, biggest: list.slice().sort((a, b) => b.amount - a.amount).slice(0, 5),
    };
  }
  /** Totals per month for the last n months (for the trend chart). */
  function trend(db, ym, n = 6) {
    return Array.from({ length: n }, (_, i) => addMonths(ym, i - n + 1)).map((m) => ({ month: m, total: money(db.expenses.filter((e) => monthOf(e.date) === m).reduce((s, e) => s + e.amount, 0)) }));
  }

  /* ---------------------------------------------------------------- categories */
  function saveCategory(db, input) {
    const name = clean(input.name, 40);
    if (!name) fail('e_catName');
    if (db.categories.some((c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase())) fail('e_catUsed', { name });
    const budget = input.budget === '' || input.budget === undefined ? 0 : money(input.budget);
    if (!(budget >= 0)) fail('e_budget');
    const old = input.id ? db.categories.find((c) => c.id === input.id) : null;
    const c = { id: old ? old.id : uid(), name, icon: clean(input.icon, 4) || '📌', color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#78716c', budget };
    if (old) Object.assign(old, c); else db.categories.push(c);
    return old || c;
  }
  /** Delete a category; its expenses and monthly bills move to `moveTo`. */
  function removeCategory(db, id, moveTo) {
    if (db.categories.length <= 1) fail('e_lastCat');
    const target = db.categories.find((c) => c.id === moveTo && c.id !== id) || db.categories.find((c) => c.id !== id);
    let moved = 0;
    for (const e of db.expenses) if (e.category === id) { e.category = target.id; moved++; }
    for (const r of db.recurring) if (r.category === id) r.category = target.id;
    db.categories = db.categories.filter((c) => c.id !== id);
    return { moved, to: target.id };
  }
  /** Match a category name suggested by the AI to one of ours. */
  function matchCategory(db, name) {
    const n = clean(name).toLowerCase();
    if (!n) return null;
    return (db.categories.find((c) => c.name.toLowerCase() === n) || db.categories.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase())) || null)?.id || null;
  }

  /* ---------------------------------------------------------------- monthly bills (recurring) */
  function saveRecurring(db, input) {
    const amount = money(input.amount);
    if (!(amount > 0)) fail('e_amount');
    if (!db.categories.some((c) => c.id === input.category)) fail('e_category');
    const day = Math.round(Number(input.day));
    if (!(day >= 1 && day <= 28)) fail('e_day');
    const old = input.id ? db.recurring.find((r) => r.id === input.id) : null;
    const r = { id: old ? old.id : uid(), payee: clean(input.payee, 100), amount, category: input.category, method: METHODS.includes(input.method) ? input.method : 'transfer',
      day, note: clean(input.note, 200), active: input.active !== false, lastAdded: old ? old.lastAdded : null };
    if (old) Object.assign(old, r); else db.recurring.push(r);
    return old || r;
  }
  function removeRecurring(db, id) {
    if (!db.recurring.some((r) => r.id === id)) fail('e_recurring');
    db.recurring = db.recurring.filter((r) => r.id !== id);
  }
  /** Bills whose day has come this month and that haven't been added yet. */
  function recurringDue(db, now = Date.now()) {
    const today = dateStr(now), ym = monthOf(today), d = Number(today.slice(8));
    return db.recurring.filter((r) => r.active && r.day <= d && r.lastAdded !== ym);
  }
  function addRecurring(db, id, now = Date.now(), amount) {
    const r = db.recurring.find((x) => x.id === id);
    if (!r) fail('e_recurring');
    const ym = monthOf(dateStr(now));
    const e = saveExpense(db, { date: `${ym}-${pad(r.day)}`, amount: amount ?? r.amount, category: r.category, payee: r.payee, method: r.method, note: r.note, recurringId: r.id }, now);
    r.lastAdded = ym;
    return e;
  }
  function skipRecurring(db, id, now = Date.now()) {
    const r = db.recurring.find((x) => x.id === id);
    if (!r) fail('e_recurring');
    r.lastAdded = monthOf(dateStr(now));
    return r;
  }

  /* ---------------------------------------------------------------- export */
  const csvCell = (x) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  /** File name for a receipt inside an export: 2026-11-10_1250_Makro_1.jpg */
  function receiptFileName(e, i, ext) {
    const payee = (e.payee || 'receipt').normalize('NFC').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'receipt';
    return `${e.date}_${String(e.amount).replace('.', '-')}_${payee}_${i + 1}.${ext}`;
  }
  function expensesCsv(db, list, receiptNames = () => [], catName = (c) => c.name) {
    const cat = (id) => { const c = db.categories.find((x) => x.id === id); return c ? catName(c) : ''; };
    const rows = [['date', 'payee', 'category', 'amount', 'vat', 'method', 'note', 'receipts']];
    for (const e of list.slice().sort((a, b) => a.date.localeCompare(b.date))) rows.push([e.date, e.payee, cat(e.category), e.amount, e.vat, e.method, e.note, receiptNames(e).join(' ')]);
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }
  function exportData(db) { return JSON.stringify({ app: 'expense-tracker', exportedAt: new Date().toISOString(), db }); }
  function importData(text) {
    let j;
    try { j = JSON.parse(text); } catch { fail('e_backup'); }
    if (!j || j.app !== 'expense-tracker' || !j.db || !Array.isArray(j.db.expenses)) fail('e_backup');
    return migrate(j.db);
  }
  /** VAT included in a price: amount × rate / (100 + rate). */
  const vatIncluded = (amount, rate) => money(Number(amount) * Number(rate) / (100 + Number(rate)));

  /* ---------------------------------------------------------------- free receipt reading (text from on-device OCR) */
  const THAI_MONTHS = ['ม.ค', 'ก.พ', 'มี.ค', 'เม.ย', 'พ.ค', 'มิ.ย', 'ก.ค', 'ส.ค', 'ก.ย', 'ต.ค', 'พ.ย', 'ธ.ค'];
  const THAI_MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** Buddhist years (2569) and 2-digit years (69 = 2569, 26 = 2026) to a normal year. */
  function fixYear(y) {
    y = Number(y);
    if (y >= 2400) return y - 543;
    if (y < 100) return y >= 60 ? 2500 + y - 543 : 2000 + y;
    return y;
  }
  function findDates(text) {
    const out = [];
    const push = (y, m, d) => { const s = `${fixYear(y)}-${pad(m)}-${pad(d)}`; if (validDate(s)) out.push(s); };
    for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(m[1], m[2], m[3]);
    for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g)) {
      let [d, mo] = [Number(m[1]), Number(m[2])];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];        // written month first
      push(m[3], mo, d);
    }
    const flat = text.replace(/(?<=[฀-๿.])\s+(?=[฀-๿.])/g, '');   // OCR puts spaces between Thai letters
    THAI_MONTHS_LONG.forEach((name, i) => { for (const m of flat.matchAll(new RegExp(`(\\d{1,2})\\s*${name}\\s*(\\d{4}|\\d{2})`, 'g'))) push(m[2], i + 1, m[1]); });
    THAI_MONTHS.forEach((name, i) => { for (const m of flat.matchAll(new RegExp(`(\\d{1,2})\\s*${name.replace('.', '\\.')}\\.?\\s*(\\d{4}|\\d{2})`, 'g'))) push(m[2], i + 1, m[1]); });
    for (const m of text.matchAll(/\b(\d{1,2})[\s-]*([A-Za-z]{3})[a-z]*[\s,-]*(\d{4}|\d{2})\b/g)) { const i = EN_MONTHS.indexOf(m[2].toLowerCase()); if (i >= 0) push(m[3], i + 1, m[1]); }
    for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) { const i = EN_MONTHS.indexOf(m[1].toLowerCase()); if (i >= 0) push(m[3], i + 1, m[2]); }
    return out;
  }
  /** Money amounts on one line (percentages, dates, times, phone and tax numbers left out). */
  function lineAmounts(line) {
    const s = line
      .replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')
      .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
    const out = [];
    for (const m of s.matchAll(/(?<![\d,.])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d,])/g)) {
      const raw = m[1];
      if (raw.replace(/[,.]/g, '').length > 8) continue;
      const v = Number(raw.replace(/,/g, ''));
      if (v > 0 && v < 10000000) out.push({ v, cents: /\.\d{2}$/.test(raw) });
    }
    return out;
  }
  const KW = {
    grand: /grand ?total|net ?total|total ?due|amount ?due|balance ?due|รวมทั้งสิ้น|ยอดสุทธิ|ยอดชำระ|สุทธิ|จำนวนเงินรวม|รวมเงินทั้งสิ้น|ยอดรวมทั้งสิ้น/i,
    total: /\btotal\b|\bamount\b|ยอดรวม|รวมเงิน|รวม|ทั้งหมด/i,
    sub: /sub ?total|before ?vat|ก่อนภาษี|ไม่รวมภาษี|มูลค่าสินค้า/i,
    skip: /change|cash ?tendered|tender|received|discount|saving|points?|ทอน|รับเงิน|ส่วนลด|แต้ม|qty|จำนวนชิ้น|ชิ้น|items?\b/i,
    vat: /\bvat\b|ภาษีมูลค่าเพิ่ม|ภาษี/i,
    merchantSkip: /tax|tel|phone|fax|receipt|invoice|date|time|pos|cashier|ใบเสร็จ|ใบกำกับ|โทร|เลขประจำตัว|วันที่|เวลา|สาขา|branch|www\.|http|@|ที่อยู่|address/i,
  };
  const CAT_WORDS = [
    ['c8', /ptt|bangchak|shell|esso|caltex|susco|gasohol|diesel|benzine|fuel|ปตท|บางจาก|น้ำมัน|แก๊สโซฮอล์|ดีเซล|เบนซิน/i],
    ['c3', /การไฟฟ้า|ไฟฟ้า|ประปา|electric|water ?works|\bpea\b|\bmea\b|\bpwa\b|\bmwa\b/i],
    ['c6', /packaging|บรรจุภัณฑ์|กล่องอาหาร|ถุงพลาสติก|ถุงหิ้ว/i],
    ['c1', /makro|แม็คโคร|lotus|โลตัส|big ?c|บิ๊กซี|tops|villa|market|ตลาด|ผัก|หมู|ไก่|ข้าวสาร|ซุปเปอร์|supermarket|food|อาหาร/i],
    ['c9', /repair|ซ่อม|service ?center/i],
  ];
  /**
   * Pull the shop, date, total, VAT and payment method out of OCR text, using simple rules.
   * Returns the same shape as the AI reader so the form fills the same way.
   */
  function parseReceiptText(text, opts = {}) {
    const todayStr = opts.today || dateStr(Date.now());
    const norm = String(text || '').replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0E50)).replace(/\r/g, '');
    const lines = norm.split('\n').map((l) => l.replace(/[|_~^`]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const flatOf = (l) => l.replace(/(?<=[฀-๿])\s+(?=[฀-๿])/g, '');
    // total: the number on (or just under) the strongest "total" line
    let best = null;
    lines.forEach((line, i) => {
      const f = flatOf(line);
      if (KW.skip.test(f) && !KW.grand.test(f)) return;
      const rank = KW.grand.test(f) ? 3 : KW.sub.test(f) ? 1 : KW.vat.test(f) ? 0 : KW.total.test(f) ? 2 : 0;
      if (!rank) return;
      let nums = lineAmounts(line);
      if (!nums.length && lines[i + 1] && !/[A-Za-z฀-๿]{3}/.test(lines[i + 1])) nums = lineAmounts(lines[i + 1]);
      if (!nums.length) return;
      const v = nums[nums.length - 1].v;
      if (!best || rank > best.rank || (rank === best.rank && v > best.v)) best = { v, rank };
    });
    const all = lines.flatMap((l) => (KW.skip.test(flatOf(l)) ? [] : lineAmounts(l).filter((a) => a.cents)));
    let total = best ? best.v : all.length ? Math.max(...all.map((a) => a.v)) : 0;
    // VAT: an amount on a VAT line that is smaller than the total
    let vat = 0;
    for (const line of lines) {
      const f = flatOf(line);
      if (!KW.vat.test(f) || /เลขประจำตัว|tax ?id|tax ?no|taxid/i.test(f)) continue;
      const v = lineAmounts(line).map((a) => a.v).filter((x) => x < total && x !== 7).pop();
      if (v) vat = v;
    }
    if (vat && vat > total * 0.2) vat = 0;
    // date: the first real date that isn't in the future (and not more than 2 years old)
    const minDate = `${Number(todayStr.slice(0, 4)) - 2}${todayStr.slice(4)}`;
    const date = findDates(lines.join('\n')).find((d) => d <= todayStr && d >= minDate) || '';
    // shop: the first line near the top that looks like a name
    let merchant = '';
    for (const line of lines.slice(0, 6)) {
      const f = flatOf(line);
      const letters = (f.match(/[A-Za-z฀-๿]/g) || []).length;
      if (letters >= 3 && letters / f.length > 0.5 && !KW.merchantSkip.test(f)) { merchant = clean(f.replace(/[^\p{L}\p{M}\p{N} &'.\-()]/gu, ''), 60); break; }
    }
    const flat = flatOf(lines.join(' '));
    const payment_method = /promptpay|พร้อมเพย์|thai ?qr|qr ?pay/i.test(flat) ? 'promptpay'
      : /visa|master ?card|credit|debit|card|บัตร|jcb|unionpay|amex/i.test(flat) ? 'card'
      : /transfer|โอน/i.test(flat) ? 'transfer'
      : /\bcash\b|เงินสด/i.test(flat) ? 'cash' : 'unknown';
    const category = (CAT_WORDS.find(([, re]) => re.test(flat)) || [])[0] || '';
    const found = !!total;
    return {
      is_receipt: found, merchant, date, total: money(total), vat: money(vat), currency: '', category, payment_method, items: [],
      confidence: best && best.rank >= 2 && date ? 'medium' : 'low', notes: '', free: true,
    };
  }

  root.EX = {
    DB_KEY, METHODS, DEFAULT_NAMES, ExpenseError, msg, dateStr, validDate, monthOf, addMonths, daysInMonth, uid, money,
    defaultsDb, migrate, saveExpense, removeExpense, findDuplicate, filterExpenses, monthSummary, trend,
    saveCategory, removeCategory, matchCategory, saveRecurring, removeRecurring, recurringDue, addRecurring, skipRecurring,
    receiptFileName, expensesCsv, exportData, importData, vatIncluded, parseReceiptText, fixYear,
  };
})(typeof window !== 'undefined' ? window : globalThis);
