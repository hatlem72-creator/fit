/* Fit Log – personal calorie & food tracker. All data stays on this device (IndexedDB). */
(() => {
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const MEALS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };
const z = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const r0 = v => Math.round(+v || 0), r1 = v => Math.round((+v || 0) * 10) / 10;
const fmt = v => r0(v).toLocaleString('en-GB');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2200, undo) {
  const t = $('#toast'); $('#toastMsg').textContent = msg; t.classList.remove('hidden');
  const u = $('#toastUndo'); u.classList.toggle('hidden', !undo); u.onclick = undo ? async () => { t.classList.add('hidden'); await undo(); } : null;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), undo ? 5000 : ms);
}

/* ---------- storage (IndexedDB key/value) ---------- */
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { const q = indexedDB.open('fitlog', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => { this.db = q.result; res(); }; q.onerror = () => rej(q.error); }); },
  tx(mode) { return this.db.transaction('kv', mode).objectStore('kv'); },
  get(k) { return new Promise((res, rej) => { const q = this.tx('readonly').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  set(k, v) { return new Promise((res, rej) => { const q = this.tx('readwrite').put(v, k); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); },
  del(k) { return new Promise((res, rej) => { const q = this.tx('readwrite').delete(k); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); },
  all() { return new Promise((res, rej) => { const out = {}; const q = this.tx('readonly').openCursor(); q.onsuccess = () => { const c = q.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; q.onerror = () => rej(q.error); }); },
  clear() { return new Promise((res, rej) => { const q = this.tx('readwrite').clear(); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); }
};

const S = { profile: {}, settings: {}, weights: [], foods: [], combos: [], days: {}, lock: null };
const today = () => ymd(new Date());
let curDay = today(), curView = 'today', weekOffset = 0;

async function loadAll() {
  const all = await DB.all();
  S.profile = all.profile || { sex: 'male', goal: 'recomp', rate: 0.5, sessions: 3, lossGoal: 10, stepsGoal: 8000, rowGoal: 15, schema: 2 };
  S.settings = all.settings || {};
  S.weights = all.weights || [];
  S.foods = all.foods || [];
  S.combos = all.meals || [];
  S.days = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith('day:')) S.days[k.slice(4)] = v;
  await migrate();
}
/* schema migration: v1 -> v2 only adds fields, never removes or rewrites existing data */
const SCHEMA = 3;
async function migrate() {
  const p = S.profile;
  if ((p.schema || 1) >= SCHEMA) return;
  // v3: foods get named portions + usage counts; saved meals list
  let fch = false;
  const counts = {};
  for (const D of Object.values(S.days)) for (const e of D.entries || []) if (e.productId) counts[e.productId] = (counts[e.productId] || 0) + 1;
  for (const f of S.foods) {
    if (!Array.isArray(f.portions)) { f.portions = f.servingG ? [{ name: 'serving', g: f.servingG }] : []; fch = true; }
    if (f.uses == null || f.uses < (counts[f.id] || 0)) { f.uses = counts[f.id] || 0; fch = true; }
  }
  if (fch) await DB.set('foods', S.foods);
  if (!Array.isArray(S.combos)) { S.combos = []; await DB.set('meals', S.combos); }
  if (p.stepsGoal == null) p.stepsGoal = 8000;
  if (p.rowGoal == null) p.rowGoal = 15;
  if (p.manual == null) p.manual = false;
  if (p.mFatAuto == null) p.mFatAuto = true;
  if (p.goal === 'recomp' && !p.startWeight) p.startWeight = firstWeight() || p.weight;
  p.schema = SCHEMA;
  for (const [d, D] of Object.entries(S.days)) {
    let ch = false;
    if (!Array.isArray(D.entries)) { D.entries = []; ch = true; }
    if (!Array.isArray(D.workouts)) { D.workouts = []; ch = true; }
    if (!D.activity) { D.activity = {}; ch = true; }
    if (!D.habits) { D.habits = {}; ch = true; }
    if (ch) await DB.set('day:' + d, D);
  }
  await DB.set('profile', p);
}
function firstWeight() { const w = [...S.weights].sort((a, b) => a.date < b.date ? -1 : 1); return w.length ? w[0].kg : null; }
function day(d = curDay) { return S.days[d] || (S.days[d] = { entries: [], water: 0, activity: {}, workouts: [], habits: {} }); }
const saveDay = (d = curDay) => DB.set('day:' + d, day(d));
const saveKey = k => DB.set(k, S[k]);

/* ---------- PIN lock ---------- */
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 150000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
let lockMode = 'unlock', lockResolve = null, lastHidden = 0;
function showLock(mode) {
  lockMode = mode;
  $('#lock').classList.remove('hidden');
  $('#pinErr').textContent = ''; $('#pinInput').value = ''; $('#pinInput2').value = '';
  const create = mode === 'create' || mode === 'first';
  $('#pinInput2').classList.toggle('hidden', !create);
  $('#pinSkip').classList.toggle('hidden', mode === 'unlock');
  $('#pinSkip').textContent = mode === 'first' ? 'Skip – no PIN' : 'Cancel';
  $('#lockTitle').textContent = mode === 'first' ? 'Welcome to Fit Log' : 'Fit Log';
  $('#lockMsg').textContent = create ? 'Create a PIN (4–12 digits) to keep your log private on this phone.' : 'Enter your PIN';
  $('#pinBtn').textContent = create ? 'Save PIN' : 'Unlock';
  setTimeout(() => $('#pinInput').focus(), 50);
  return new Promise(r => { lockResolve = r; });
}
function hideLock(v) { $('#lock').classList.add('hidden'); if (lockResolve) { const r = lockResolve; lockResolve = null; r(v); } }
async function pinSubmit() {
  const p = $('#pinInput').value.trim();
  if (lockMode === 'unlock') {
    const lock = await DB.get('lock');
    if (lock && await hashPin(p, lock.salt) === lock.hash) hideLock(true);
    else { $('#pinErr').textContent = 'Wrong PIN'; $('#pinInput').value = ''; }
    return;
  }
  if (!/^\d{4,12}$/.test(p)) { $('#pinErr').textContent = 'Use 4–12 digits'; return; }
  if (p !== $('#pinInput2').value.trim()) { $('#pinErr').textContent = "PINs don't match"; return; }
  const salt = uid() + uid();
  await DB.set('lock', { salt, hash: await hashPin(p, salt), v: 1 });
  S.settings.pinAsked = true; await saveKey('settings');
  toast('PIN saved'); hideLock(true);
}
$('#pinBtn').onclick = pinSubmit;
$('#pinInput').onkeydown = $('#pinInput2').onkeydown = e => { if (e.key === 'Enter') pinSubmit(); };
$('#pinSkip').onclick = async () => { if (lockMode === 'first') { S.settings.pinAsked = true; await saveKey('settings'); } hideLock(false); };
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) lastHidden = Date.now();
  else if (lastHidden && Date.now() - lastHidden > 5 * 60 * 1000 && await DB.get('lock')) showLock('unlock');
});

/* ---------- derived numbers ---------- */
function latestWeight() { const w = [...S.weights].sort((a, b) => a.date < b.date ? -1 : 1); return w.length ? w[w.length - 1].kg : null; }
function T() { return Calc.targets(S.profile); }
function dayTotals(d) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, salt: 0, fibre: 0 };
  for (const e of day(d).entries) for (const k in t) t[k] += +e[k] || 0;
  return t;
}
function burnt(d) {
  const a = day(d).activity || {}, tg = T();
  if (+a.total) return { v: +a.total, src: 'watch' };
  if (+a.active) return { v: tg.bmr + +a.active, src: 'BMR + active' };
  return tg.tdee ? { v: tg.tdee, src: 'est.' } : { v: 0, src: '' };
}
function E() { return Calc.effective(S.profile); }
function targetFor(d) {
  const tg = T();
  if (S.profile.manual) return E().kcal;   // fixed intake target; watch calories only change the balance
  if (S.profile.adaptive) { const b = burnt(d); if (b.src !== 'est.' && b.v) return Math.max(S.profile.sex === 'female' ? 1200 : 1500, Math.round(b.v + tg.delta)); }
  return tg.kcal;
}
function workoutCount(d) { return (day(d).workouts || []).length; }
/* habits */
const stepsGoal = () => +S.profile.stepsGoal || 8000, rowGoal = () => +S.profile.rowGoal || 15;
const isRow = w => /row|roing|roe/i.test(w.type || '');
function habitState(d) {
  const D = S.days[d] || {}, a = D.activity || {}, h = D.habits || {};
  const steps = +a.steps || 0, rowMin = (D.workouts || []).filter(isRow).reduce((s, w) => s + (+w.minutes || 0), 0);
  const sAuto = steps >= stepsGoal(), rAuto = rowMin >= rowGoal();
  return { steps, rowMin, sAuto, rAuto, sDone: sAuto || !!h.steps, rDone: rAuto || !!h.row };
}
function bothDone(d) { const h = habitState(d); return h.sDone && h.rDone; }
function streak() {
  // consecutive days with both habits done, ending today (or yesterday if today isn't finished yet)
  let d = today(), n = 0;
  if (!bothDone(d)) d = addDays(d, -1);
  while (bothDone(d) && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------- navigation ---------- */
function setView(v) {
  curView = v;
  $$('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $$('.tabs button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('.top').classList.toggle('hidden', v === 'week' || v === 'me');
  render();
  window.scrollTo(0, 0);
}
$$('.tabs button[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$('#prevDay').onclick = () => { curDay = addDays(curDay, -1); render(); };
$('#nextDay').onclick = () => { curDay = addDays(curDay, 1); render(); };
$('#dayPicker').onchange = e => { if (e.target.value) { curDay = e.target.value; render(); } };
function dayLabel(d) {
  const t = today();
  if (d === t) return 'Today'; if (d === addDays(t, -1)) return 'Yesterday'; if (d === addDays(t, 1)) return 'Tomorrow';
  return parseYmd(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function render() {
  $('#dayLabel').textContent = dayLabel(curDay); $('#dayPicker').value = curDay;
  if (curView === 'today') renderToday();
  if (curView === 'activity') renderActivity();
  if (curView === 'week') renderWeek();
  if (curView === 'me') renderMe();
}

/* ---------- TODAY ---------- */
function ring(svg, parts) {
  const R = 52, C = 2 * Math.PI * R;
  let html = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="12"/>`;
  let off = 0;
  for (const p of parts) {
    const len = Math.max(0, Math.min(1, p.f)) * C;
    if (len > 0) html += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${p.c}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${len} ${C}" stroke-dashoffset="${-off}"/>`;
    off += len;
  }
  svg.innerHTML = html;
}
function renderToday() {
  const tg = T(), tot = dayTotals(curDay), target = targetFor(curDay), b = burnt(curDay);
  const remain = target - tot.kcal;
  $('#remainNum').textContent = target ? fmt(Math.abs(remain)) : fmt(tot.kcal);
  $('#remainLbl').textContent = !target ? 'kcal eaten' : remain >= 0 ? 'kcal left' : 'kcal over';
  $('#remainNum').style.color = target && remain < 0 ? 'var(--bad)' : '';
  ring($('#kcalRing'), target ? [{ f: tot.kcal / target, c: remain < 0 ? 'var(--bad)' : 'var(--brand2)' }] : []);
  $('#tTarget').textContent = target ? fmt(target) : '–';
  $('#tEaten').textContent = fmt(tot.kcal);
  $('#tBurnt').textContent = b.v ? fmt(b.v) : '–'; $('#burntSrc').textContent = b.src ? '(' + b.src + ')' : '';
  const bal = b.v ? tot.kcal - b.v : null;
  $('#tBalance').textContent = bal == null ? '–' : (bal > 0 ? '+' : '') + fmt(bal);
  $('#tBalance').style.color = bal == null ? '' : bal < 0 ? 'var(--ok)' : 'var(--accent)';
  const ef = E(), scale = !ef.manual && tg.kcal ? target / tg.kcal : 1;
  for (const m of ['protein', 'carbs', 'fat']) {
    const el = $(`.macro[data-m=${m}]`), sc = m === 'protein' ? 1 : scale;
    const lo = Math.round(ef[m].min * sc), hi = Math.round(ef[m].max * sc), v = tot[m];
    const bar = el.querySelector('.bar'), i = bar.querySelector('i');
    let band = bar.querySelector('.band'); if (!band) { band = document.createElement('span'); band.className = 'band'; bar.appendChild(band); }
    if (!hi) { el.querySelector('.mval').textContent = `${r0(v)} g`; i.style.width = '0'; band.style.display = 'none'; continue; }
    const full = hi * 1.25, st = v < lo ? 'under' : v > hi ? 'over' : 'in';
    el.querySelector('.mval').innerHTML = `${r0(v)} g <span class="muted">/ ${lo === hi ? hi : lo + '–' + hi} g</span><span class="st ${st}">${st === 'in' ? '✓' : st === 'under' ? '↓ ' + r0(lo - v) : '↑ ' + r0(v - hi)}</span>`;
    band.style.display = ''; band.style.left = (lo / full * 100) + '%'; band.style.width = ((hi - lo) / full * 100) + '%';
    i.style.width = Math.min(100, v / full * 100) + '%';
    i.classList.remove('in', 'under', 'over'); i.classList.add(st);
    el.dataset.state = st;
  }
  renderHabits(); renderGoalProgress();
  // water
  const wGoal = +S.profile.water || 2500, w = day().water || 0;
  $('#waterVal').textContent = `${fmt(w)} / ${fmt(wGoal)} ml`;
  const n = Math.max(Math.ceil(wGoal / 250), Math.ceil(w / 250));
  $('#glasses').innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < w / 250 ? 'full' : ''}"></span>`).join('');
  // activity mini
  const a = day().activity || {};
  $('#actMini').innerHTML = `<div><b>${a.active ? fmt(a.active) : '–'}</b><span class="tiny muted">active kcal</span></div><div><b>${a.steps ? fmt(a.steps) : '–'}</b><span class="tiny muted">steps</span></div><div><b>${workoutCount(curDay)}</b><span class="tiny muted">workouts</span></div>`;
  // meals
  const entries = day().entries;
  $('#meals').innerHTML = Object.entries(MEALS).map(([k, label]) => {
    const list = entries.filter(e => e.meal === k), kc = list.reduce((s, e) => s + (+e.kcal || 0), 0);
    return `<div class="card meal"><h3><span>${label} <small class="muted">${list.length ? fmt(kc) + ' kcal' : ''}</small></span><span>${list.length ? `<button class="add ghosty" data-savemeal="${k}" aria-label="Save ${label.toLowerCase()} as a meal">💾</button> ` : ''}<button class="add" data-add="${k}">＋ Add</button></span></h3>
      ${list.map(e => `<div class="entry" data-entry="${e.id}">${thumbHtml(e.thumb || prodThumb(e.productId))}<div class="info"><div class="nm">${esc(e.name)}</div><div class="sub">${amountTxt(e)} · P ${r1(e.protein)} · C ${r1(e.carbs)} · F ${r1(e.fat)}</div></div><div class="kc">${fmt(e.kcal)}</div></div>`).join('')}</div>`;
  }).join('');
  $$('#meals [data-add]').forEach(b => b.onclick = () => openSheet(b.dataset.add));
  $$('#meals [data-savemeal]').forEach(b => b.onclick = () => saveCombo(b.dataset.savemeal));
  renderQuick();
  $$('#meals [data-entry]').forEach(el => el.onclick = () => editEntry(el.dataset.entry));
  $('#profileHint').innerHTML = tg.bmr ? '' : 'Set up your profile under <b>Me</b> to get a daily target.';
}
function renderHabits() {
  const h = habitState(curDay), D = day();
  $('#hStepsGoal').textContent = fmt(stepsGoal()); $('#hRowGoal').textContent = rowGoal();
  $('#hStepsCb').checked = h.sDone; $('#hStepsCb').disabled = h.sAuto;
  $('#hRowCb').checked = h.rDone; $('#hRowCb').disabled = h.rAuto;
  $('#hStepsVal').textContent = h.steps ? `${fmt(h.steps)}${h.sAuto ? ' ✓ auto' : ''}` : 'no steps yet';
  $('#hRowVal').textContent = h.rowMin ? `${h.rowMin} min${h.rAuto ? ' ✓ auto' : ''}` : 'not yet';
  $('#hSteps').classList.toggle('done', h.sDone); $('#hRow').classList.toggle('done', h.rDone);
  $('#qRow').textContent = `+ Rowing ${rowGoal()} min`;
  const n = streak(); $('#streak').textContent = n ? `🔥 ${n}-day streak` : '';
}
$('#hStepsCb').onchange = e => { day().habits = { ...(day().habits || {}), steps: e.target.checked }; saveDay(); renderToday(); };
$('#hRowCb').onchange = e => { day().habits = { ...(day().habits || {}), row: e.target.checked }; saveDay(); renderToday(); };
$('#qRow').onclick = async () => { const D = day(); D.workouts = D.workouts || []; D.workouts.push({ type: 'Rowing', minutes: rowGoal(), kcal: 0, source: 'quick' }); await saveDay(); toast(`Rowing ${rowGoal()} min logged`); renderToday(); };
$('#qSteps').onclick = () => { setView('activity'); setTimeout(() => $('#aSteps').focus(), 50); };
function renderGoalProgress() {
  const p = S.profile, gw = Calc.goalWeight(p), card = $('#goalCard');
  const start = p.goal === 'recomp' ? +p.startWeight : (firstWeight() || +p.weight), now = latestWeight() || +p.weight;
  if (!gw || !start || !now || p.goal === 'maintain') { card.classList.add('hidden'); return; }
  const total = Math.abs(start - gw), done = p.goal === 'gain' ? now - start : start - now, f = total ? Math.max(0, Math.min(1, done / total)) : 0;
  card.classList.remove('hidden');
  card.innerHTML = `<div class="row between"><h3>${p.goal === 'recomp' ? '💪 Recomp goal' : '⚖️ Weight goal'}</h3><span class="muted tiny">${r1(start)} → ${r1(gw)} kg</span></div>
    <div class="gbar"><i style="width:${f * 100}%"></i></div>
    <div class="row between tiny"><span><b>${done >= 0 ? '−' : '+'}${r1(Math.abs(done))} kg</b> of ${p.goal === 'gain' ? '+' : '−'}${r1(total)} kg (${Math.round(f * 100)}%)</span><span class="muted">now ${r1(now)} kg · ${r1(Math.max(0, Math.abs(now - gw)))} kg to go</span></div>`;
}
function prodThumb(id) { const p = S.foods.find(f => f.id === id); return p && p.thumb; }
function thumbHtml(src) { return src ? `<img class="thumb" src="${esc(src)}" alt="">` : `<div class="thumb ph">🍽️</div>`; }
$('#waterPlus').onclick = () => { day().water = (day().water || 0) + 250; saveDay(); renderToday(); };
$('#waterMinus').onclick = () => { day().water = Math.max(0, (day().water || 0) - 250); saveDay(); renderToday(); };
$('#actMini').onclick = () => setView('activity');

/* ---------- ACTIVITY ---------- */
let draftWorkouts = [];
function renderActivity() {
  const a = day().activity || {};
  $('#aActive').value = a.active ?? ''; $('#aTotal').value = a.total ?? ''; $('#aSteps').value = a.steps ?? '';
  draftWorkouts = JSON.parse(JSON.stringify(day().workouts || []));
  renderWorkouts(); $('#aSaved').textContent = '';
  let h = '<div class="hist h"><span>Day</span><span>Active</span><span>Steps</span><span>Training</span></div>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(today(), -i), x = (S.days[d] && S.days[d].activity) || {}, wk = (S.days[d] && S.days[d].workouts) || [];
    h += `<div class="hist"><span>${dayLabel(d)}</span><span>${x.active ? fmt(x.active) : '–'}</span><span>${x.steps ? fmt(x.steps) : '–'}</span><span>${wk.length ? wk.map(w => esc(w.type)).join(', ') : '–'}</span></div>`;
  }
  $('#actHistory').innerHTML = h;
}
function renderWorkouts() {
  $('#workoutList').innerHTML = draftWorkouts.length ? draftWorkouts.map((w, i) => `<div class="list"><div class="item"><span>🏋️ ${esc(w.type)} · ${r0(w.minutes)} min${w.kcal ? ' · ' + fmt(w.kcal) + ' kcal' : ''}</span><button class="x" data-wdel="${i}" aria-label="Remove">✕</button></div></div>`).join('') : '<p class="tiny muted">No workouts yet for this day.</p>';
  $$('[data-wdel]').forEach(b => b.onclick = () => { draftWorkouts.splice(+b.dataset.wdel, 1); renderWorkouts(); });
}
$$('#quickW [data-q]').forEach(b => b.onclick = () => { const [t, m] = b.dataset.q.split('|'); draftWorkouts.push({ type: t, minutes: +m, kcal: 0, source: 'manual' }); $('#aSave').onclick(); toast(`${t} ${m} min saved`); });
$('#wAdd').onclick = () => {
  const m = +$('#wMin').value;
  if (!m) { toast('Enter the minutes'); return; }
  draftWorkouts.push({ type: $('#wType').value, minutes: m, kcal: +$('#wKcal').value || 0, source: 'manual' });
  $('#wMin').value = ''; $('#wKcal').value = ''; renderWorkouts();
};
$('#aSave').onclick = async () => {
  if ($('#wMin').value) $('#wAdd').onclick();
  const num = id => { const v = $(id).value; return v === '' ? undefined : +v; };
  day().activity = { active: num('#aActive'), total: num('#aTotal'), steps: num('#aSteps') };
  day().workouts = draftWorkouts;
  await saveDay(); $('#aSaved').textContent = '✓ Saved for ' + dayLabel(curDay).toLowerCase(); renderActivity(); $('#aSaved').textContent = '✓ Saved for ' + dayLabel(curDay).toLowerCase();
};
$('#importAct').onchange = async e => {
  const files = [...e.target.files]; let nd = 0, nw = 0, kinds = [];
  for (const f of files) {
    try {
      const text = await f.text(); let res;
      if (/\.csv$/i.test(f.name) || !/^\s*[\[{]/.test(text)) res = Importers.csv(text);
      else res = Importers.huawei(JSON.parse(text));
      kinds.push(...res.kind);
      for (const [d, v] of Object.entries(res.days)) {
        const D = day(d); D.activity = D.activity || {};
        if (v.active != null) D.activity.active = v.active; if (v.total != null) D.activity.total = v.total; if (v.steps != null) D.activity.steps = v.steps;
        await saveDay(d); nd++;
      }
      for (const w of res.workouts) {
        const D = day(w.date); D.workouts = D.workouts || [];
        const dup = D.workouts.some(x => (w.start && x.start === w.start) || (x.type === w.type && x.minutes === w.minutes && x.source === w.source));
        if (!dup) { D.workouts.push(w); nw++; await saveDay(w.date); }
      }
    } catch (err) { toast('Could not read ' + f.name); console.error(err); }
  }
  $('#importActMsg').textContent = `Imported ${nd} day(s) and ${nw} workout(s)${kinds.length ? ' (' + [...new Set(kinds)].join(', ') + ')' : ''}.`;
  e.target.value = ''; renderActivity();
};

/* ---------- WEEK ---------- */
let charts = {};
function chart(id, cfg) { if (!window.Chart) return; if (charts[id]) charts[id].destroy(); charts[id] = new Chart($('#' + id), cfg); }
function weekStart(offset) { const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow + offset * 7); return ymd(d); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function renderWeek() {
  const ws = weekStart(weekOffset), days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  $('#weekLabel').textContent = weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : parseYmd(ws).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + parseYmd(days[6]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const eaten = days.map(d => S.days[d] ? r0(dayTotals(d).kcal) : 0);
  const burn = days.map(d => (S.days[d] && S.days[d].activity && (S.days[d].activity.total || S.days[d].activity.active)) ? r0(burnt(d).v) : 0);
  const logged = days.filter((d, i) => eaten[i] > 0);
  const t = today(), past = days.filter(d => d <= t);
  const avgE = logged.length ? eaten.filter(v => v > 0).reduce((a, b) => a + b, 0) / logged.length : 0;
  const bDays = burn.filter(v => v > 0);
  const avgB = bDays.length ? bDays.reduce((a, b) => a + b, 0) / bDays.length : 0;
  $('#wAvgEaten').textContent = avgE ? fmt(avgE) + ' kcal' : '–';
  $('#wAvgBurnt').textContent = avgB ? fmt(avgB) + ' kcal' : '–';
  let bal = 0, nb = 0; days.forEach((d, i) => { if (eaten[i] > 0 && d <= t) { bal += eaten[i] - (burn[i] || burnt(d).v); nb++; } });
  $('#wBalance').textContent = nb ? (bal > 0 ? '+' : '') + fmt(bal) + ' kcal' : '–';
  $('#wBalance').style.color = !nb ? '' : bal < 0 ? 'var(--ok)' : 'var(--accent)';
  const sessions = days.reduce((s, d) => s + (S.days[d] ? workoutCount(d) : 0), 0), goal = +S.profile.sessions || 0;
  $('#wTraining').textContent = `${sessions} / ${goal || '–'} sessions`;
  $('#trainDots').innerHTML = days.map(d => { const n = S.days[d] ? workoutCount(d) : 0; return `<span><i class="${n ? 'on' : ''}">${n ? '💪' : ''}</i>${parseYmd(d).toLocaleDateString('en-GB', { weekday: 'narrow' })}</span>`; }).join('');
  const hs = days.map(d => ({ d, fut: d > t, ...habitState(d) }));
  const row = (label, key) => `<div class="hweek"><span>${label}</span>${hs.map(h => `<span class="d ${h[key] ? 'on' : ''} ${h.fut ? 'fut' : ''}">${h[key] ? '✓' : ''}</span>`).join('')}<b>${hs.filter(h => h[key]).length}/7</b></div>`;
  const both = hs.filter(h => h.sDone && h.rDone).length;
  $('#habitWeek').innerHTML = `<div class="hweek h"><span></span>${days.map(d => `<span class="d">${parseYmd(d).toLocaleDateString('en-GB', { weekday: 'narrow' })}</span>`).join('')}<b></b></div>`
    + row(`🚶 ${fmt(stepsGoal())} steps`, 'sDone') + row(`🚣 Row ${rowGoal()} min`, 'rDone')
    + `<p class="tiny muted">Both habits done on ${both} of 7 days (${Math.round(both / 7 * 100)}%).</p>`;
  const st = streak(); $('#wStreak').textContent = st ? `🔥 ${st}-day streak` : '';
  const target = S.profile.manual ? E().kcal : T().kcal;
  chart('weekChart', { type: 'bar', data: { labels: days.map(d => parseYmd(d).toLocaleDateString('en-GB', { weekday: 'short' })),
    datasets: [{ label: 'Eaten', data: eaten, backgroundColor: '#14b8a6', borderRadius: 6 }, { label: 'Burnt', data: burn, backgroundColor: '#f97316', borderRadius: 6 },
      ...(target ? [{ type: 'line', label: 'Target', data: days.map(() => target), borderColor: '#64748b', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }] : [])] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), boxWidth: 12 } } }, scales: { x: { ticks: { color: css('--muted') }, grid: { display: false } }, y: { ticks: { color: css('--muted') }, grid: { color: css('--line') } } } } });
  const mac = ['protein', 'carbs', 'fat'].map(m => logged.length ? r0(logged.reduce((s, d) => s + dayTotals(d)[m], 0) / logged.length) : 0), tg = T();
  chart('macroChart', { type: 'bar', data: { labels: ['Protein', 'Carbs', 'Fat'], datasets: [{ label: 'Avg / day (g)', data: mac, backgroundColor: ['#6366f1', '#f59e0b', '#ec4899'], borderRadius: 6 }, { label: 'Target range (g)', data: ['protein', 'carbs', 'fat'].map(m => [E()[m].min, Math.max(E()[m].max, E()[m].min + 1)]), backgroundColor: 'rgba(22,163,74,.28)', borderRadius: 6 }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), boxWidth: 12 } } }, scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--line') } }, y: { ticks: { color: css('--muted') }, grid: { display: false } } } } });
  weightChart('weightChart', +$('#weightRange').value);
  const ws2 = [...S.weights].sort((a, b) => a.date < b.date ? -1 : 1);
  if (ws2.length >= 2) {
    const a = ws2[0], b = ws2[ws2.length - 1], wk = Math.max(1, (parseYmd(b.date) - parseYmd(a.date)) / 864e5 / 7), ch = b.kg - a.kg;
    $('#weightTrendTxt').textContent = `${ch > 0 ? '+' : ''}${r1(ch)} kg since ${parseYmd(a.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (${r1(ch / wk)} kg/week)` + (Calc.goalWeight(S.profile) ? ` · ${r1(Math.max(0, Math.abs(b.kg - Calc.goalWeight(S.profile))))} kg to goal` : '') + (S.profile.goal === 'recomp' && S.profile.startWeight ? ` · ${r1(S.profile.startWeight - b.kg)} of ${S.profile.lossGoal || 10} kg lost` : '');
  } else $('#weightTrendTxt').textContent = 'Log your weight under Me to see the trend.';
}
function weightChart(id, rangeDays) {
  const from = addDays(today(), -rangeDays);
  const pts = [...S.weights].filter(w => w.date >= from).sort((a, b) => a.date < b.date ? -1 : 1);
  const tw = Calc.goalWeight(S.profile), sw = S.profile.goal === 'recomp' ? +S.profile.startWeight : 0;
  chart(id, { type: 'line', data: { labels: pts.map(p => parseYmd(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
    datasets: [{ label: 'Weight (kg)', data: pts.map(p => p.kg), borderColor: '#0f766e', backgroundColor: 'rgba(20,184,166,.15)', fill: true, tension: .3, pointRadius: 3 },
      ...(tw ? [{ label: S.profile.goal === 'recomp' ? `Goal (−${S.profile.lossGoal || 10} kg)` : 'Target', data: pts.map(() => tw), borderColor: '#16a34a', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }] : []),
      ...(sw ? [{ label: 'Start', data: pts.map(() => sw), borderColor: '#94a3b8', borderDash: [2, 3], pointRadius: 0, borderWidth: 1 }] : [])] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), boxWidth: 12 } } }, scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 6 }, grid: { display: false } }, y: { ticks: { color: css('--muted') }, grid: { color: css('--line') } } } } });
}
$('#prevWeek').onclick = () => { weekOffset--; renderWeek(); };
$('#nextWeek').onclick = () => { weekOffset++; renderWeek(); };
$('#weightRange').onchange = () => renderWeek();

/* ---------- ME ---------- */
const PF = { weight: '#pWeight', height: '#pHeight', age: '#pAge', sex: '#pSex', sessions: '#pSessions', goal: '#pGoal', targetWeight: '#pTarget', rate: '#pRate', proteinPerKg: '#pProt', fatPct: '#pFat', water: '#pWater',
  startWeight: '#pStart', lossGoal: '#pLoss', stepsGoal: '#pStepsGoal', rowGoal: '#pRowGoal',
  mKcal: '#mKcal', mProtMin: '#mProtMin', mProtMax: '#mProtMax', mCarbMin: '#mCarbMin', mCarbMax: '#mCarbMax', mFatMin: '#mFatMin', mFatMax: '#mFatMax' };
const STR = new Set(['sex', 'goal']);
function renderMe() {
  for (const [k, id] of Object.entries(PF)) $(id).value = S.profile[k] ?? '';
  if (!S.profile.rate) $('#pRate').value = '0.5';
  $('#pAdaptive').checked = !!S.profile.adaptive;
  $('#pManual').checked = !!S.profile.manual;
  $('#mFatAuto').checked = S.profile.mFatAuto !== false;
  if (!$('#pStepsGoal').value) $('#pStepsGoal').value = 8000;
  if (!$('#pRowGoal').value) $('#pRowGoal').value = 15;
  renderCalc();
  $('#wtDate').value = today();
  const ws = [...S.weights].sort((a, b) => a.date < b.date ? 1 : -1);
  $('#wtList').innerHTML = ws.slice(0, 30).map(w => `<div class="item"><span>${parseYmd(w.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span><span><b>${r1(w.kg)} kg</b> <button class="x" data-wtdel="${w.date}" aria-label="Delete">✕</button></span></div>`).join('');
  $$('[data-wtdel]').forEach(b => b.onclick = async () => { S.weights = S.weights.filter(w => w.date !== b.dataset.wtdel); await saveKey('weights'); syncWeight(); renderMe(); });
  weightChart('weightChart2', 365);
  DB.get('lock').then(l => { $('#pinSetBtn').textContent = l ? 'Change PIN' : 'Set PIN'; $('#pinRemoveBtn').classList.toggle('hidden', !l); $('#lockNowBtn').classList.toggle('hidden', !l); });
}
function readProfileForm() {
  const p = { ...S.profile };
  for (const [k, id] of Object.entries(PF)) { const v = $(id).value; p[k] = STR.has(k) ? v : (v === '' ? undefined : +v); }
  p.adaptive = $('#pAdaptive').checked; p.manual = $('#pManual').checked; p.mFatAuto = $('#mFatAuto').checked;
  p.schema = SCHEMA;
  return p;
}
function fillPlanIfEmpty() {
  const P = Calc.PLAN;
  if (!$('#mKcal').value) $('#mKcal').value = P.mKcal;
  if (!$('#mProtMin').value && !$('#mProtMax').value) { $('#mProtMin').value = P.mProtMin; $('#mProtMax').value = P.mProtMax; }
  if (!$('#mCarbMin').value && !$('#mCarbMax').value) { $('#mCarbMin').value = P.mCarbMin; $('#mCarbMax').value = P.mCarbMax; }
}
function renderCalc() {
  const p = readProfileForm(), t = Calc.targets(p), ef = Calc.effective(p);
  // form state
  const rc = p.goal === 'recomp';
  $$('.recomp-only').forEach(e => e.classList.toggle('hidden', !rc)); $('#fTargetW').classList.toggle('hidden', rc);
  $('#manualBox').classList.toggle('off', !p.manual);
  if (p.mFatAuto !== false) { const f = Calc.autoFat(+p.mKcal || 0, +p.mProtMin || 0, +p.mProtMax || +p.mProtMin || 0, +p.mCarbMin || 0, +p.mCarbMax || +p.mCarbMin || 0); if (p.mKcal) { $('#mFatMin').value = f.min; $('#mFatMax').value = f.max; } }
  $('#mFatMin').readOnly = $('#mFatMax').readOnly = p.mFatAuto !== false;
  $('#pAdaptive').disabled = p.manual; $('#adaptiveRow').style.opacity = p.manual ? .5 : 1;
  $('#adaptiveNote').textContent = p.manual ? `Manual targets are on: your intake target stays fixed at ${fmt(ef.kcal)} kcal. Watch calories are only used for the burnt / balance numbers.` : '';
  if (p.manual) {
    const k = (r, f) => `${fmt(r.min * f)}–${fmt(r.max * f)}`;
    const mid = r => (r.min + r.max) / 2, sum = mid(ef.protein) * 4 + mid(ef.carbs) * 4 + mid(ef.fat) * 9;
    $('#manualSum').textContent = `Protein ${k(ef.protein, 4)} kcal · carbs ${k(ef.carbs, 4)} kcal · fat ${k(ef.fat, 9)} kcal → mid-points add up to ${fmt(sum)} of ${fmt(ef.kcal)} kcal.`;
  } else $('#manualSum').textContent = '';
  const gw = Calc.goalWeight(p);
  if (!t.bmr) { $('#calcCard').innerHTML = '<h3>Your numbers</h3><p class="muted">Fill in weight, height and age.</p>'; return; }
  const goalTxt = (p.goal === 'lose' || rc) ? `−${fmt(-t.delta)} kcal/day to lose ${p.rate} kg/week` : p.goal === 'gain' ? `+${fmt(t.delta)} kcal/day to gain ${p.rate} kg/week` : 'Maintain weight';
  const rg = r => r.min === r.max ? `${r.max} g` : `${r.min}–${r.max} g`;
  const deficit = t.tdee - ef.kcal, wk = p.manual && deficit > 0 ? deficit * 7 / Calc.KCAL_PER_KG : null;
  const weeks = gw && p.weight ? (wk ? Math.abs(p.weight - gw) / wk : t.weeksToGoal) : null;
  $('#calcCard').innerHTML = `<h3>Your numbers ${p.manual ? '<small class="muted">(manual targets)</small>' : ''}</h3>
   <div class="kpis"><div><span class="lbl">BMR (Mifflin-St Jeor)</span><b>${fmt(t.bmr)} kcal</b></div><div><span class="lbl">TDEE (× ${t.factor})</span><b>${fmt(t.tdee)} kcal</b></div>
   <div><span class="lbl">Daily target${p.manual ? ' (manual)' : ''}</span><b style="color:var(--brand)">${fmt(ef.kcal)} kcal</b></div><div><span class="lbl">BMI</span><b>${r1(t.bmi)}</b></div>
   <div><span class="lbl">Protein</span><b>${rg(ef.protein)}</b></div><div><span class="lbl">Carbs</span><b>${rg(ef.carbs)}</b></div><div><span class="lbl">Fat</span><b>${rg(ef.fat)}</b></div>
   <div><span class="lbl">Goal weight</span><b>${gw ? r1(gw) + ' kg' : '–'}</b></div>
   <div><span class="lbl">To goal</span><b>${weeks ? '≈ ' + Math.ceil(weeks) + ' weeks' : '–'}</b></div></div>
   <p class="tiny muted">${p.manual ? `Your fixed target is ${fmt(Math.abs(deficit))} kcal/day ${deficit >= 0 ? 'below' : 'above'} the estimated TDEE${wk ? ` (≈ ${r1(wk)} kg/week)` : ''}. Calculated suggestion: ${fmt(t.kcal)} kcal.` : goalTxt + (t.floored ? ' · capped at the safe minimum' : '') + '.'}${rc ? ' Recomposition: keep protein high and train strength to hold on to muscle while losing fat.' : ''}</p>`;
}
Object.values(PF).forEach(id => $(id).addEventListener('input', renderCalc));
$('#pAdaptive').onchange = renderCalc; $('#mFatAuto').onchange = renderCalc;
$('#pGoal').addEventListener('change', () => { if ($('#pGoal').value === 'recomp') { if (!$('#pStart').value) $('#pStart').value = latestWeight() || $('#pWeight').value || ''; if (!$('#pLoss').value) $('#pLoss').value = 10; } renderCalc(); });
$('#pManual').onchange = () => { if ($('#pManual').checked) fillPlanIfEmpty(); renderCalc(); };
async function saveProfile(msgSel) {
  const p = readProfileForm(), old = S.profile.weight;
  if (p.goal === 'recomp') { if (!p.startWeight) p.startWeight = latestWeight() || p.weight; if (!p.lossGoal) p.lossGoal = 10; }
  S.profile = p; await saveKey('profile');
  if (p.weight && p.weight !== old && p.weight !== latestWeight()) { upsertWeight(today(), p.weight); await saveKey('weights'); }
  renderMe(); $(msgSel).textContent = '✓ Saved';
}
$('#pSave').onclick = () => saveProfile('#pSaved');
$('#tSave').onclick = () => saveProfile('#tSaved');
$('#planBtn').onclick = async () => {
  const P = Calc.PLAN;
  $('#pManual').checked = true; $('#mFatAuto').checked = true;
  $('#mKcal').value = P.mKcal; $('#mProtMin').value = P.mProtMin; $('#mProtMax').value = P.mProtMax; $('#mCarbMin').value = P.mCarbMin; $('#mCarbMax').value = P.mCarbMax;
  $('#pStepsGoal').value = P.stepsGoal; $('#pRowGoal').value = P.rowGoal;
  $('#pGoal').value = 'recomp'; if (!$('#pStart').value) $('#pStart').value = latestWeight() || $('#pWeight').value || ''; $('#pLoss').value = P.lossGoal;
  renderCalc(); await saveProfile('#tSaved'); $('#tSaved').textContent = "✓ My plan applied: 1,870 kcal, protein 180–190 g, carbs 100–130 g, recomp −10 kg";
};
function upsertWeight(date, kg) { S.weights = S.weights.filter(w => w.date !== date); S.weights.push({ date, kg }); }
function syncWeight() { const lw = latestWeight(); if (lw) { S.profile.weight = lw; saveKey('profile'); } }
$('#wtAdd').onclick = async () => {
  const kg = +$('#wtKg').value, d = $('#wtDate').value || today();
  if (!(kg > 20 && kg < 400)) { toast('Enter a weight in kg'); return; }
  upsertWeight(d, kg); await saveKey('weights'); syncWeight(); $('#wtKg').value = ''; toast('Weight saved'); renderMe();
};
// backup
$('#exportBtn').onclick = async () => {
  const all = await DB.all(); delete all.lock;
  const data = { app: 'fitlog', version: 2, exported: new Date().toISOString(), data: all };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `fitlog-backup-${today()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: 'Fit Log backup' }); $('#backupMsg').textContent = '✓ Backup shared'; return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('#backupMsg').textContent = '✓ Backup saved as ' + name;
};
$('#importBtn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'fitlog' || !j.data) throw new Error('not a Fit Log backup');
    const nDays = Object.keys(j.data).filter(k => k.startsWith('day:')).length;
    if (!confirm(`Restore backup from ${j.exported ? new Date(j.exported).toLocaleString('en-GB') : 'file'} with ${nDays} days? This replaces the data on this device (your PIN stays).`)) { e.target.value = ''; return; }
    const lock = await DB.get('lock'); await DB.clear(); if (lock) await DB.set('lock', lock);
    for (const [k, v] of Object.entries(j.data)) if (k !== 'lock') await DB.set(k, v);
    await loadAll(); $('#backupMsg').textContent = `✓ Restored ${nDays} days, ${S.foods.length} foods, ${S.weights.length} weigh-ins`; render(); $('#backupMsg').textContent = `✓ Restored ${nDays} days, ${S.foods.length} foods, ${S.weights.length} weigh-ins`;
  } catch (err) { $('#backupMsg').textContent = 'Could not import: ' + err.message; }
  e.target.value = '';
};
$('#pinSetBtn').onclick = async () => { await showLock('create'); renderMe(); };
$('#pinRemoveBtn').onclick = async () => { if (!confirm('Remove the PIN?')) return; const ok = await showLock('unlock'); if (ok) { await DB.del('lock'); toast('PIN removed'); renderMe(); } };
$('#lockNowBtn').onclick = () => showLock('unlock');
$('#wipeBtn').onclick = async () => {
  if (!confirm('Delete ALL data on this device? Make a backup first.')) return;
  if (!confirm('Really delete everything?')) return;
  await DB.clear(); await loadAll(); S.settings.pinAsked = true; await saveKey('settings'); toast('All data deleted'); setView('today');
};

/* ---------- ADD FOOD SHEET ---------- */
let sheetMeal = 'breakfast', sheetMode = 'label', editingId = null, currentThumb = null;
const FF = { kcal: '#fKcal', protein: '#fProtein', carbs: '#fCarbs', fat: '#fFat', sugar: '#fSugar', satfat: '#fSatfat', fibre: '#fFibre', salt: '#fSalt', kj: '#fKj' };
function guessMeal() { const h = new Date().getHours(); return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snacks'; }
function openSheet(meal, mode) {
  sheetMeal = meal || guessMeal(); editingId = null; editingProduct = null;
  $('#sheet').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#sheetTitle').textContent = 'Add food'; $('#mealChips').classList.remove('hidden'); $('#modeSeg').classList.remove('hidden');
  $('#productForm').reset(); $('#productForm').dataset.pid = ''; currentThumb = null; $('#fThumb').classList.add('hidden');
  $('#bcInput').value = ''; $('#bcStatus').textContent = 'Looks the product up in the free Open Food Facts database.'; $('#libSearch').value = '';
  setMeal(sheetMeal); setMode(mode || (S.foods.length ? 'library' : 'label'));
}
function closeSheet() { $('#sheet').classList.add('hidden'); document.body.style.overflow = ''; stopScan(); render(); }
$('#sheetClose').onclick = closeSheet;
$('#addFab').onclick = () => openSheet();
function setMeal(m) { sheetMeal = m; $$('#mealChips button').forEach(b => b.classList.toggle('on', b.dataset.meal === m)); $('#fSubmit').textContent = editingProduct ? 'Save food' : editingId ? 'Save changes' : 'Add to ' + MEALS[m].toLowerCase(); }
$$('#mealChips button').forEach(b => b.onclick = () => setMeal(b.dataset.meal));
function setMode(m) {
  sheetMode = m; stopScan();
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  ['label', 'barcode', 'library'].forEach(x => $('#mode-' + x).classList.toggle('hidden', x !== m));
  $('#productForm').classList.toggle('hidden', m !== 'manual');
  if (m === 'manual') fillForm({});
  if (m === 'library') renderLib();
  if (m === 'label') { $('#ocrBox').classList.add('hidden'); }
}
$$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

let formPortions = [], fAmt = null, editingProduct = null;
function fillForm(p, grams, unit, qty) {
  $('#productForm').classList.remove('hidden');
  $('#fName').value = p.name || ''; $('#fBrand').value = p.brand || ''; $('#fBarcode').value = p.barcode || '';
  const per = p.per100 || {};
  for (const [k, id] of Object.entries(FF)) { $(id).value = per[k] ?? ''; $(id).classList.remove('fixed', 'missing'); }
  $('#fWhole').checked = false; $('#basisLbl').textContent = p.basis === '100ml' ? 'Per 100 ml' : 'Per 100 g';
  $('#fFav').checked = !!p.fav; $('#fSaveLib').checked = true;
  currentThumb = p.thumb || null; $('#fThumb').classList.toggle('hidden', !currentThumb); if (currentThumb) $('#fThumb').src = currentThumb;
  $('#productForm').dataset.pid = p.id || '';
  $('#fDelete').classList.toggle('hidden', !editingId && !editingProduct);
  $('#fDelete').textContent = editingProduct ? 'Delete this food' : 'Remove from log';
  formPortions = (p.portions && p.portions.length ? p.portions : (p.servingG ? [{ name: 'serving', g: p.servingG }] : [])).map(x => ({ ...x }));
  renderPortionRows();
  const init = initAmount(p, grams, unit, qty);
  fAmt = amountUI($('#fAmount'), () => formPortions, init, g => { $('#fGrams').value = g; updatePreview(); });
  $('#fAmount').classList.toggle('hidden', !!editingProduct); $('#fPreview').classList.toggle('hidden', !!editingProduct);
  $('#fSaveOnly').classList.toggle('hidden', !!editingId || !!editingProduct);
  updatePreview(); setMeal(sheetMeal);
}
function initAmount(p, grams, unit, qty) {
  const ps = (p.portions || []);
  if (unit && unit !== 'g' && ps.some(x => x.name === unit)) return { unit, qty: qty || 1 };
  if (grams) return { unit: 'g', qty: grams };
  if (p.lastUnit && p.lastUnit !== 'g' && ps.some(x => x.name === p.lastUnit)) return { unit: p.lastUnit, qty: p.lastQty || 1 };
  if (ps.length && +ps[0].g > 0 && (!p.lastUnit || !p.lastGrams)) return { unit: ps[0].name, qty: p.lastGrams ? Math.max(0.5, Math.round(p.lastGrams / ps[0].g * 2) / 2) : 1 };
  if (p.lastGrams) return { unit: 'g', qty: p.lastGrams };
  if (ps.length) return { unit: ps[0].name, qty: 1 };
  return { unit: 'g', qty: p.servingG || 100 };
}
function renderPortionRows() {
  $('#portionRows').innerHTML = formPortions.map((x, i) => `<div class="prow"><input data-pn="${i}" value="${esc(x.name)}" placeholder="slice" aria-label="Portion name"><input data-pg="${i}" type="number" step="any" inputmode="decimal" value="${x.g ?? ''}" placeholder="35" aria-label="Grams per portion"><span>g</span><button type="button" class="x" data-pdel="${i}" aria-label="Remove portion">✕</button></div>`).join('');
  $$('#portionRows [data-pn]').forEach(el => el.oninput = () => { formPortions[+el.dataset.pn].name = el.value.trim(); });
  $$('#portionRows [data-pg]').forEach(el => el.oninput = () => { formPortions[+el.dataset.pg].g = +el.value || 0; });
  $$('#portionRows input').forEach(el => el.onchange = () => fAmt && fAmt.rebuild());
  $$('#portionRows [data-pdel]').forEach(b => b.onclick = () => { formPortions.splice(+b.dataset.pdel, 1); renderPortionRows(); fAmt && fAmt.rebuild(); });
}
$('#addPortion').onclick = () => { formPortions.push({ name: '', g: '' }); renderPortionRows(); const ins = $$('#portionRows [data-pn]'); ins[ins.length - 1].focus(); };
/* amount picker: grams or a named portion, with big −/+ buttons */
function amountUI(root, getPortions, init, onChange) {
  const st = { unit: init.unit || 'g', qty: +init.qty || 100 };
  const valid = () => getPortions().filter(p => p.name && +p.g > 0);
  const pg = () => { const p = valid().find(x => x.name === st.unit); return p ? +p.g : null; };
  const grams = () => { const g = pg(); return Math.round((g ? st.qty * g : st.qty) * 10) / 10; };
  function update() {
    const q = root.querySelector('.q'); if (document.activeElement !== q) q.value = st.qty;
    root.querySelector('.eq').textContent = st.unit === 'g' ? '' : `= ${fmt(grams())} g`;
    onChange(grams(), st);
  }
  function rebuild() {
    const ps = valid();
    if (st.unit !== 'g' && !ps.some(p => p.name === st.unit)) { st.unit = 'g'; st.qty = 100; }
    root.innerHTML = `<span class="lbl">Amount</span><div class="stepper"><button type="button" class="mn" aria-label="Less">−</button><input type="number" step="any" inputmode="decimal" class="q" aria-label="Amount"><button type="button" class="pl" aria-label="More">＋</button></div>
      <div class="chips small">${['g', ...ps.map(p => p.name)].map(u => `<button type="button" data-u="${esc(u)}" class="${u === st.unit ? 'on' : ''}">${u === 'g' ? 'grams' : esc(u) + ' · ' + r1(ps.find(p => p.name === u).g) + ' g'}</button>`).join('')}</div><div class="eq"></div>`;
    const step = dir => { const g = st.unit === 'g'; let v = +st.qty || 0;
      if (g) { const s = v < 50 ? 5 : v < 200 ? 10 : 25; v = Math.max(0, Math.round((v + dir * s) / s) * s); }
      else v = dir > 0 ? (v < 1 ? v + 0.5 : Math.floor(v) + 1) : (v <= 1 ? Math.max(0.5, v - 0.5) : Math.ceil(v) - 1);
      st.qty = Math.round(v * 10) / 10; update(); };
    root.querySelector('.mn').onclick = () => step(-1); root.querySelector('.pl').onclick = () => step(1);
    root.querySelector('.q').oninput = e => { st.qty = +e.target.value || 0; update(); };
    root.querySelectorAll('[data-u]').forEach(b => b.onclick = () => {
      const g = grams(), u = b.dataset.u; st.unit = u;
      const p = pg(); st.qty = u === 'g' ? Math.round(g) : Math.max(0.5, Math.round(g / p * 2) / 2); rebuild();
    });
    update();
  }
  rebuild();
  return { grams, st, rebuild };
}
const plural = (n, u) => +n === 1 || /s$/i.test(u) ? u : u + 's';
function amountTxt(e) { return e.unit && e.unit !== 'g' && e.qty ? `${r1(e.qty)} ${esc(plural(e.qty, e.unit))} · ${r0(e.grams)} g` : (e.grams ? `${r0(e.grams)} g` : '1 portion'); }
function formPer() { const o = {}; for (const [k, id] of Object.entries(FF)) { const v = $(id).value; if (v !== '') o[k] = +v; } if (o.kcal == null && o.kj) o.kcal = r0(o.kj / 4.184); return o; }
function formPortion() {
  const per = formPer(), g = +$('#fGrams').value || 0;
  if ($('#fWhole').checked) return { ...per };
  return Calc.portion(per, g);
}
function updatePreview() {
  const pt = formPortion(), per = formPer();
  $('#fPreview').innerHTML = `<div><b>${fmt(pt.kcal)}</b><span>kcal</span></div><div><b>${r1(pt.protein)}</b><span>protein g</span></div><div><b>${r1(pt.carbs)}</b><span>carbs g</span></div><div><b>${r1(pt.fat)}</b><span>fat g</span></div>`;
  $('#basisLbl').textContent = $('#fWhole').checked ? 'Whole portion' : ($('#basisLbl').textContent.includes('ml') ? 'Per 100 ml' : 'Per 100 g');
  let warn = '';
  if (per.kcal && per.protein != null && per.carbs != null && per.fat != null) {
    const est = per.protein * 4 + per.carbs * 4 + per.fat * 9 + (per.fibre || 0) * 2;
    if (Math.abs(est - per.kcal) > Math.max(25, per.kcal * .2)) warn = `⚠️ Check the numbers: the macros add up to ≈${r0(est)} kcal, not ${r0(per.kcal)}.`;
  }
  if (!$('#fWhole').checked && per.kcal > 900) warn = '⚠️ More than 900 kcal per 100 g is unusual – check the kcal value.';
  $('#fCheck').textContent = warn;
}
$('#productForm').addEventListener('input', e => { e.target.classList && e.target.classList.remove('fixed', 'missing'); updatePreview(); });
function saveProductFromForm() {
  const name = $('#fName').value.trim(), per = formPer();
  if (!name || per.kcal == null) { toast('Name and kcal are needed'); return null; }
  const whole = $('#fWhole').checked, grams = +$('#fGrams').value || (whole ? 0 : 100);
  let per100 = per;
  if (whole && grams) per100 = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, r1(v * 100 / grams)]));
  const portions = formPortions.filter(x => x.name && +x.g > 0).map(x => ({ name: x.name, g: +x.g }));
  return { name, per100, whole, grams, portions };
}
async function upsertProduct(f, pid, opts = {}) {
  let p = pid && S.foods.find(x => x.id === pid);
  if (!p) { p = { id: uid(), created: Date.now(), uses: 0 }; S.foods.push(p); }
  Object.assign(p, { name: f.name, brand: $('#fBrand').value.trim(), barcode: $('#fBarcode').value || p.barcode, per100: f.per100, portions: f.portions, thumb: currentThumb || p.thumb, fav: $('#fFav').checked });
  if (opts.used) Object.assign(p, { lastGrams: f.grams, lastUnit: opts.unit, lastQty: opts.qty, lastMeal: opts.meal, lastUsed: Date.now(), uses: (p.uses || 0) + 1 });
  await saveKey('foods');
  return p;
}
$('#productForm').onsubmit = async e => {
  e.preventDefault();
  const f = saveProductFromForm(); if (!f) return;
  let pid = $('#productForm').dataset.pid || null;
  if (editingProduct) { const p = await upsertProduct(f, editingProduct); toast(`Saved ${p.name}`); closeSheet(); return; }
  const unit = fAmt ? fAmt.st.unit : 'g', qty = fAmt ? fAmt.st.qty : f.grams;
  if ($('#fSaveLib').checked && (!f.whole || f.grams)) pid = (await upsertProduct(f, pid, { used: !editingId, unit, qty, meal: sheetMeal })).id;
  else if (pid) { const p = S.foods.find(x => x.id === pid); if (p) { p.fav = $('#fFav').checked; await saveKey('foods'); } }
  const pt = $('#fWhole').checked ? formPer() : Calc.portion(f.per100, f.grams);
  const entry = { id: editingId || uid(), meal: sheetMeal, name: f.name + ($('#fBrand').value.trim() ? ' · ' + $('#fBrand').value.trim() : ''), grams: f.grams || null,
    unit: f.whole ? undefined : unit, qty: f.whole ? undefined : qty,
    kcal: r0(pt.kcal), protein: r1(pt.protein), carbs: r1(pt.carbs), fat: r1(pt.fat), sugar: r1(pt.sugar), salt: r1(pt.salt), fibre: r1(pt.fibre),
    productId: pid, per100: f.per100, time: Date.now() };
  if (!pid && currentThumb) entry.thumb = currentThumb;
  const D = day();
  if (editingId) { const i = D.entries.findIndex(x => x.id === editingId); D.entries[i] = { ...D.entries[i], ...entry }; }
  else D.entries.push(entry);
  await saveDay();
  toast(`${editingId ? 'Updated' : 'Added'} ${entry.kcal} kcal to ${MEALS[sheetMeal].toLowerCase()}`);
  closeSheet();
};
$('#fSaveOnly').onclick = async () => {
  const f = saveProductFromForm(); if (!f) return;
  const p = await upsertProduct(f, $('#productForm').dataset.pid || null);
  toast(`Saved “${p.name}” to My foods`); closeSheet();
};
function editProduct(id) {
  const f = S.foods.find(x => x.id === id); if (!f) return;
  openSheet(); editingProduct = id;
  $('#sheetTitle').textContent = 'Edit food'; $('#modeSeg').classList.add('hidden'); $('#mealChips').classList.add('hidden');
  ['label', 'barcode', 'library'].forEach(x => $('#mode-' + x).classList.add('hidden'));
  fillForm(f); $('#fSubmit').textContent = 'Save food';
}
function editEntry(id) {
  const e = day().entries.find(x => x.id === id); if (!e) return;
  openSheet(e.meal); editingId = id;
  $('#sheetTitle').textContent = 'Edit entry'; $('#modeSeg').classList.add('hidden');
  ['label', 'barcode', 'library'].forEach(x => $('#mode-' + x).classList.add('hidden'));
  const p = S.foods.find(f => f.id === e.productId) || {};
  const per100 = e.per100 || p.per100 || (e.grams ? Object.fromEntries(['kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'fibre'].map(k => [k, r1((e[k] || 0) * 100 / e.grams)])) : {});
  fillForm({ ...p, name: p.name || e.name, per100, thumb: p.thumb || e.thumb, id: e.productId }, e.unit && e.unit !== 'g' ? null : e.grams, e.unit, e.qty);
  if (!e.grams) { $('#fWhole').checked = true; for (const k of ['kcal', 'protein', 'carbs', 'fat']) $(FF[k]).value = e[k]; updatePreview(); }
  setMeal(e.meal);
}
$('#fDelete').onclick = async () => {
  if (editingProduct) { if (!confirm('Delete this food from My foods? Logged entries stay.')) return; S.foods = S.foods.filter(f => f.id !== editingProduct); await saveKey('foods'); toast('Food deleted'); closeSheet(); return; }
  const D = day(); D.entries = D.entries.filter(x => x.id !== editingId); await saveDay(); toast('Removed'); closeSheet(); };
$('#fWhole').onchange = updatePreview;

// library
function renderLib() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const list = S.foods.filter(f => !q || (f.name + ' ' + (f.brand || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.fav - a.fav) || ((b.uses || 0) - (a.uses || 0)) || ((b.lastUsed || 0) - (a.lastUsed || 0)));
  $('#libList').innerHTML = list.length ? list.map(f => `<div class="libitem" data-pid="${f.id}">${thumbHtml(f.thumb)}<div class="info"><div class="nm">${f.fav ? '⭐ ' : ''}${esc(f.name)}</div><div class="sub">${esc(f.brand || '')} ${fmt(f.per100 && f.per100.kcal)} kcal/100 g · P ${r1(f.per100 && f.per100.protein)} C ${r1(f.per100 && f.per100.carbs)} F ${r1(f.per100 && f.per100.fat)}</div></div><button class="x" data-libdel="${f.id}" aria-label="Delete from my foods">🗑</button></div>`).join('')
    : `<p class="muted">${q ? 'No match.' : 'No saved foods yet. Scan a label or add one manually and it will appear here.'}</p>`;
  $$('#libList [data-pid]').forEach(el => el.onclick = ev => {
    if (ev.target.dataset.libdel) return;
    const f = S.foods.find(x => x.id === el.dataset.pid); $('#mode-library').classList.add('hidden'); fillForm(f);
  });
  $$('[data-libdel]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); if (!confirm('Delete this food from your list?')) return; S.foods = S.foods.filter(f => f.id !== b.dataset.libdel); await saveKey('foods'); renderLib(); });
}
$('#libSearch').oninput = renderLib;

/* ---------- My foods quick log ---------- */
let quickAll = false, comboEditing = false, qProduct = null, qMeal = 'breakfast', qAmt = null;
const portionKcal = (f, g) => Calc.portion(f.per100 || {}, g);
function sortedFoods(q) {
  q = (q || '').trim().toLowerCase();
  return S.foods.filter(f => !q || (f.name + ' ' + (f.brand || '')).toLowerCase().includes(q))
    .sort((a, b) => ((b.uses || 0) - (a.uses || 0)) || (b.fav - a.fav) || ((b.lastUsed || 0) - (a.lastUsed || 0)) || a.name.localeCompare(b.name));
}
function renderQuick() {
  const q = $('#quickSearch').value, list = sortedFoods(q), shown = quickAll || q ? list : list.slice(0, 8);
  const logged = {}; for (const e of day().entries) if (e.productId) logged[e.productId] = (logged[e.productId] || 0) + 1;
  $('#quickList').innerHTML = shown.length ? shown.map(f => {
    const init = initAmount(f), ps = f.portions || [], pp = ps.find(x => x.name === init.unit);
    const g = pp ? init.qty * pp.g : init.qty, pt = portionKcal(f, g);
    const amt = pp ? `${r1(init.qty)} ${esc(plural(init.qty, pp.name))}` : `${r0(g)} g`;
    return `<div class="qi ${logged[f.id] ? 'logged' : ''}" data-q="${f.id}">${thumbHtml(f.thumb)}<div class="info"><div class="nm">${esc(f.name)}</div><div class="sub">${amt} · ${fmt(pt.kcal)} kcal · ${r1(pt.protein)} g protein${f.uses ? ` · used ${f.uses}×` : ''}</div></div><button class="ed" data-qed="${f.id}" aria-label="Edit ${esc(f.name)}">✏️</button><span class="tick">${logged[f.id] ? (logged[f.id] > 1 ? logged[f.id] : '✓') : ''}</span></div>`;
  }).join('') : `<p class="tiny muted">${q ? 'No match.' : 'Create your regular foods once (scan, barcode or manual) and they show up here, most used first.'}</p>`;
  $('#quickMore').classList.toggle('hidden', !!q || list.length <= 8);
  $('#quickMore').textContent = quickAll ? 'Show fewer' : `Show all ${list.length}`;
  $$('#quickList [data-q]').forEach(el => el.onclick = ev => { if (ev.target.closest('[data-qed]')) return; openQuick(el.dataset.q); });
  $$('#quickList [data-qed]').forEach(b => b.onclick = () => editProduct(b.dataset.qed));
  // saved meals
  $('#comboList').innerHTML = S.combos.length ? S.combos.map(c => `<button type="button" data-combo="${c.id}">🍽️ ${esc(c.name)} · ${fmt(c.items.reduce((s, e) => s + (+e.kcal || 0), 0))} kcal${comboEditing ? '<span class="x">✕</span>' : ''}</button>`).join('')
    : '<span class="tiny muted">Tap 💾 on a meal below to save it as a combo (e.g. “Standard breakfast”).</span>';
  $('#comboEdit').classList.toggle('hidden', !S.combos.length); $('#comboEdit').textContent = comboEditing ? 'Done' : 'Edit';
  $$('#comboList [data-combo]').forEach(b => b.onclick = () => comboEditing ? deleteCombo(b.dataset.combo) : logCombo(b.dataset.combo));
  const wd = parseYmd(curDay).toLocaleDateString('en-GB', { weekday: 'short' });
  $('#copyLastWk').textContent = `📋 Same as last ${wd}`;
  $('#copyYest').textContent = curDay === today() ? '📋 Copy yesterday' : '📋 Copy day before';
}
$('#quickSearch').oninput = renderQuick;
$('#quickMore').onclick = () => { quickAll = !quickAll; renderQuick(); };
$('#newFoodBtn').onclick = () => openSheet(undefined, 'label');
$('#comboEdit').onclick = () => { comboEditing = !comboEditing; renderQuick(); };
function openQuick(id) {
  const f = S.foods.find(x => x.id === id); if (!f) return;
  qProduct = f; qMeal = guessMeal();
  $('#qThumb').innerHTML = thumbHtml(f.thumb); $('#qName').textContent = f.name;
  const p = f.per100 || {};
  $('#qSub').textContent = `${fmt(p.kcal)} kcal · P ${r1(p.protein)} · C ${r1(p.carbs)} · F ${r1(p.fat)} per 100 g`;
  setQMeal(qMeal);
  qAmt = amountUI($('#qAmount'), () => f.portions || [], initAmount(f), g => {
    const pt = portionKcal(f, g);
    $('#qPreview').innerHTML = `<div><b>${fmt(pt.kcal)}</b><span>kcal</span></div><div><b>${r1(pt.protein)}</b><span>protein g</span></div><div><b>${r1(pt.carbs)}</b><span>carbs g</span></div><div><b>${r1(pt.fat)}</b><span>fat g</span></div>`;
  });
  $('#qsheet').classList.remove('hidden'); document.body.style.overflow = 'hidden';
}
function setQMeal(m) { qMeal = m; $$('#qMeals button').forEach(b => b.classList.toggle('on', b.dataset.meal === m)); $('#qLog').textContent = 'Log to ' + MEALS[m].toLowerCase(); }
$$('#qMeals button').forEach(b => b.onclick = () => setQMeal(b.dataset.meal));
function closeQuick() { $('#qsheet').classList.add('hidden'); document.body.style.overflow = ''; }
$('#qClose').onclick = closeQuick;
$('#qsheet').onclick = e => { if (e.target.id === 'qsheet') closeQuick(); };
$('#qEdit').onclick = () => { const id = qProduct.id; closeQuick(); editProduct(id); };
function entryFrom(f, grams, unit, qty, meal) {
  const pt = portionKcal(f, grams);
  return { id: uid(), meal, name: f.name + (f.brand ? ' · ' + f.brand : ''), grams, unit, qty,
    kcal: r0(pt.kcal), protein: r1(pt.protein), carbs: r1(pt.carbs), fat: r1(pt.fat), sugar: r1(pt.sugar), salt: r1(pt.salt), fibre: r1(pt.fibre),
    productId: f.id, per100: f.per100, time: Date.now() };
}
$('#qLog').onclick = async () => {
  const f = qProduct, g = qAmt.grams(); if (!g) { toast('Set an amount'); return; }
  const e = entryFrom(f, g, qAmt.st.unit, qAmt.st.qty, qMeal);
  day().entries.push(e); await saveDay();
  Object.assign(f, { uses: (f.uses || 0) + 1, lastUsed: Date.now(), lastGrams: g, lastUnit: qAmt.st.unit, lastQty: qAmt.st.qty, lastMeal: qMeal }); await saveKey('foods');
  closeQuick(); render();
  toast(`${f.name}: ${e.kcal} kcal → ${MEALS[qMeal].toLowerCase()}`, 2200, async () => { day().entries = day().entries.filter(x => x.id !== e.id); f.uses = Math.max(0, f.uses - 1); await saveDay(); await saveKey('foods'); render(); });
};
// saved meals (combos)
async function saveCombo(meal) {
  const items = day().entries.filter(e => e.meal === meal);
  if (!items.length) return;
  const name = prompt(`Name this ${MEALS[meal].toLowerCase()} combo (${items.length} items):`, 'Standard ' + MEALS[meal].toLowerCase());
  if (!name) return;
  S.combos.push({ id: uid(), name: name.trim(), meal, items: items.map(({ id, time, ...rest }) => rest), created: Date.now() });
  await DB.set('meals', S.combos); toast(`Saved meal “${name.trim()}”`); renderQuick();
}
async function addEntries(list, label) {
  const D = day(), ids = [];
  for (const e of list) { const n = { ...e, id: uid(), time: Date.now() }; ids.push(n.id); D.entries.push(n);
    const f = e.productId && S.foods.find(x => x.id === e.productId); if (f) { f.uses = (f.uses || 0) + 1; f.lastUsed = Date.now(); } }
  await saveDay(); await saveKey('foods'); render();
  const kc = list.reduce((s, e) => s + (+e.kcal || 0), 0);
  toast(`${label}: ${list.length} items, ${fmt(kc)} kcal`, 2200, async () => {
    day().entries = day().entries.filter(x => !ids.includes(x.id));
    for (const e of list) { const f = e.productId && S.foods.find(x => x.id === e.productId); if (f) f.uses = Math.max(0, (f.uses || 1) - 1); }
    await saveDay(); await saveKey('foods'); render();
  });
}
function logCombo(id) { const c = S.combos.find(x => x.id === id); if (c) addEntries(c.items.map(e => ({ ...e, meal: c.meal })), c.name); }
async function deleteCombo(id) { const c = S.combos.find(x => x.id === id); if (!c || !confirm(`Delete saved meal “${c.name}”?`)) return; S.combos = S.combos.filter(x => x.id !== id); await DB.set('meals', S.combos); renderQuick(); }
async function copyFrom(src) {
  const list = (S.days[src] && S.days[src].entries) || [];
  if (!list.length) { toast(`Nothing logged on ${dayLabel(src)}`); return; }
  if (day().entries.length && !confirm(`Add ${list.length} items from ${dayLabel(src)} to ${dayLabel(curDay).toLowerCase()}? (${day().entries.length} already logged)`)) return;
  addEntries(list.map(({ id, time, ...rest }) => rest), 'Copied ' + dayLabel(src));
}
$('#copyYest').onclick = () => copyFrom(addDays(curDay, -1));
$('#copyLastWk').onclick = () => copyFrom(addDays(curDay, -7));
$('#copyDate').onchange = e => { if (e.target.value) copyFrom(e.target.value); e.target.value = ''; };

/* ---------- images ---------- */
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function fileToImage(file) { const url = URL.createObjectURL(file); const img = await loadImage(url); return { img, url }; }
function thumbFrom(img, size = 160) {
  const c = document.createElement('canvas'), s = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', .72);
}
function prepForOcr(img, mode) {
  // scale to ~2000 px wide, greyscale, then either contrast-stretch or Otsu threshold + table-line removal
  const s = 2000 / img.naturalWidth;
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  const W = c.width, H = c.height, d = g.getImageData(0, 0, W, H), p = d.data, hist = new Array(256).fill(0);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) { const y = Math.round(.299 * p[i] + .587 * p[i + 1] + .114 * p[i + 2]); p[i] = y; sum += y; hist[y]++; }
  const mean = sum / (W * H), inv = mean < 110;
  if (mode === 'otsu' || mode === 'otsu-lines') {
    let tot = W * H, sB = 0, wB = 0, max = 0, th = 128, sAll = 0;
    for (let t = 0; t < 256; t++) sAll += t * hist[t];
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sAll - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > max) { max = v; th = t; } }
    for (let i = 0; i < p.length; i += 4) { let y = p[i] > th ? 255 : 0; if (inv) y = 255 - y; p[i] = p[i + 1] = p[i + 2] = y; }
    if (mode === 'otsu-lines') {
      for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (p[(y * W + x) * 4] === 0) n++; if (n > W * 0.35) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; p[k] = p[k + 1] = p[k + 2] = 255; } }
      const run = Math.max(30, H * 0.06);
      for (let x = 0; x < W; x++) { let st = -1; for (let y = 0; y <= H; y++) { const dark = y < H && p[(y * W + x) * 4] === 0; if (dark && st < 0) st = y; if (!dark && st >= 0) { if (y - st > run) for (let yy = st; yy < y; yy++) { const k = (yy * W + x) * 4; p[k] = p[k + 1] = p[k + 2] = 255; } st = -1; } } }
    }
  } else {
    for (let i = 0; i < p.length; i += 4) { let y = (p[i] - mean) * 1.6 + 128; y = y < 0 ? 0 : y > 255 ? 255 : y; if (inv) y = 255 - y; p[i] = p[i + 1] = p[i + 2] = y; }
  }
  g.putImageData(d, 0, 0); return c;
}

/* ---------- OCR (tesseract.js, runs on the device) ---------- */
let ocrWorker = null, ocrPass = 0, ocrPasses = 1;
function loadScript(src) { return new Promise((res, rej) => { if ([...document.scripts].some(s => s.src.endsWith(src))) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function getWorker(progress) {
  if (ocrWorker) return ocrWorker;
  await loadScript('vendor/tesseract/tesseract.min.js');
  const base = new URL('vendor/', location.href).href;
  ocrWorker = await Tesseract.createWorker(['eng', 'nld', 'nor'], 1, {
    workerPath: base + 'tesseract/worker.min.js', corePath: base + 'tesseract/', langPath: base + 'lang', gzip: true,
    logger: m => progress && progress(m)
  });
  await ocrWorker.setParameters({ preserve_interword_spaces: '1' });
  return ocrWorker;
}
async function handleLabel(file) {
  if (!file) return;
  $('#ocrBox').classList.remove('hidden'); $('#productForm').classList.add('hidden'); $('#ocrStatus').textContent = 'Opening photo…';
  const { img, url } = await fileToImage(file);
  $('#ocrPreview').src = url; $('#ocrBar').style.width = '3%'; $('#ocrText').textContent = '';
  const st = $('#ocrStatus'); ocrPass = 0; ocrPasses = 1;
  st.textContent = ocrWorker ? 'Reading the label…' : 'Loading the reader (first time ≈15 MB, then offline)…';
  try {
    const w = await getWorker(m => {
      if (m.status === 'recognizing text') { const f = (ocrPass + m.progress) / ocrPasses; $('#ocrBar').style.width = (30 + f * 70) + '%'; st.textContent = 'Reading the label… ' + Math.round(f * 100) + '%'; }
      else if (m.progress != null) $('#ocrBar').style.width = Math.max(3, m.progress * 30) + '%';
    });
    // read the label in up to three passes (different clean-ups); numbers are cross-checked against the label's kcal
    const passes = [['contrast', '6'], ['otsu-lines', '6'], ['otsu', '6']], texts = [];
    let r = null;
    for (let i = 0; i < passes.length; i++) {
      ocrPass = i; ocrPasses = passes.length;
      await w.setParameters({ tessedit_pageseg_mode: passes[i][1] });
      const { data } = await w.recognize(prepForOcr(img, passes[i][0]));
      texts.push(data.text);
      r = LabelParse.parseMany(texts);
      if (r.tight && r.found.length >= 6) break;
    }
    $('#ocrBar').style.width = '100%';
    $('#ocrText').textContent = texts.map((t, i) => `--- pass ${i + 1} ---\n${t}`).join('\n');
    const n = ['kcal', 'protein', 'carbs', 'fat'].filter(k => r[k] != null).length;
    st.textContent = n ? `Found ${r.found.length} values${r.checkOk === false ? ' – some look off, please check' : r.fixed.length ? ' (orange = decimal fixed by the kcal check)' : ''}. Check them, add a name and the grams you ate.` : "Couldn't find nutrition values. Try a sharper, straight-on photo that fills the frame, or type them in below.";
    fillForm({ name: '', per100: { kcal: r.kcal, kj: r.kj, protein: r.protein, carbs: r.carbs, fat: r.fat, sugar: r.sugar, satfat: r.satfat, fibre: r.fibre, salt: r.salt }, basis: r.basis, thumb: thumbFrom(img) });
    for (const k of r.fixed) if (FF[k]) $(FF[k]).classList.add('fixed');
    for (const k of ['kcal', 'protein', 'carbs', 'fat']) if (r[k] == null) $(FF[k]).classList.add('missing');
    $('#fName').focus({ preventScroll: true });
    $('#ocrBox').scrollIntoView({ block: 'start' });
  } catch (err) {
    console.error(err); st.textContent = 'OCR failed (' + (err.message || err) + '). You can type the values in below.';
    fillForm({ thumb: thumbFrom(img) });
  }
}
$('#labelCam').onchange = e => { handleLabel(e.target.files[0]); e.target.value = ''; };
$('#labelFile').onchange = e => { handleLabel(e.target.files[0]); e.target.value = ''; };

/* ---------- Barcode + Open Food Facts ---------- */
let scanStream = null, scanTimer = null, zxReader = null;
async function lookupBarcode(code) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length < 6) { $('#bcStatus').textContent = 'That barcode looks too short.'; return; }
  $('#bcInput').value = code;
  const local = S.foods.find(f => f.barcode === code);
  if (local) { $('#bcStatus').textContent = 'Found in my foods.'; fillForm(local); return; }
  $('#bcStatus').textContent = 'Looking up ' + code + '…';
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,product_name_nl,product_name_no,brands,nutriments,serving_quantity,image_front_small_url,image_nutrition_small_url`);
    const j = await r.json();
    if (j.status !== 1 || !j.product) { $('#bcStatus').textContent = 'Not in Open Food Facts. Scan the label instead, or enter it manually.'; fillForm({ barcode: code }); $('#fBarcode').value = code; return; }
    const p = j.product, n = p.nutriments || {};
    const g = k => n[k + '_100g'] != null ? r1(n[k + '_100g']) : undefined;
    let kcal = n['energy-kcal_100g']; if (kcal == null && n['energy-kj_100g'] != null) kcal = n['energy-kj_100g'] / 4.184; if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184;
    let thumb = null;
    const imgUrl = p.image_front_small_url || p.image_nutrition_small_url;
    if (imgUrl) { try { thumb = thumbFrom(await loadImage(imgUrl), 200); } catch (e) { thumb = imgUrl; } }
    fillForm({ name: p.product_name || p.product_name_en || p.product_name_nl || p.product_name_no || 'Product ' + code, brand: (p.brands || '').split(',')[0].trim(), barcode: code,
      per100: { kcal: kcal != null ? r0(kcal) : undefined, kj: g('energy-kj'), protein: g('proteins'), carbs: g('carbohydrates'), fat: g('fat'), sugar: g('sugars'), satfat: g('saturated-fat'), fibre: g('fiber'), salt: g('salt') },
      servingG: p.serving_quantity ? r0(p.serving_quantity) : undefined, thumb });
    $('#bcStatus').textContent = 'Found on Open Food Facts – check the values and enter the grams.';
  } catch (err) { $('#bcStatus').textContent = 'Lookup failed (offline?). Try again later or enter it manually.'; }
}
$('#bcLookup').onclick = () => lookupBarcode($('#bcInput').value);
$('#bcInput').onkeydown = e => { if (e.key === 'Enter') lookupBarcode($('#bcInput').value); };
async function hasNativeDetector() { try { return 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('ean_13'); } catch (e) { return false; } }
$('#bcScan').onclick = async () => {
  stopScan();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#bcStatus').textContent = 'Camera not available here – use “From photo” or type the number.'; return; }
  $('#bcVideoWrap').classList.remove('hidden'); $('#bcStatus').textContent = 'Point the camera at the barcode…';
  const video = $('#bcVideo');
  try {
    if (await hasNativeDetector()) {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
      video.srcObject = scanStream; await video.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      const tick = async () => { if (!scanStream) return; try { const c = await det.detect(video); if (c.length) { const v = c[0].rawValue; stopScan(); navigator.vibrate && navigator.vibrate(80); lookupBarcode(v); return; } } catch (e) { } scanTimer = setTimeout(tick, 180); };
      tick();
    } else {
      await loadScript('vendor/zxing.min.js');
      const hints = new Map(); hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
      zxReader = new ZXing.BrowserMultiFormatReader(hints);
      await zxReader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (res) => { if (res) { const v = res.getText(); stopScan(); navigator.vibrate && navigator.vibrate(80); lookupBarcode(v); } });
    }
  } catch (err) { stopScan(); $('#bcStatus').textContent = 'Could not open the camera (' + (err.name || err) + '). Use “From photo” or type the number.'; }
};
function stopScan() {
  clearTimeout(scanTimer);
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  if (zxReader) { try { zxReader.reset(); } catch (e) { } zxReader = null; }
  $('#bcVideoWrap').classList.add('hidden');
}
$('#bcStop').onclick = stopScan;
$('#bcPhoto').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  $('#bcStatus').textContent = 'Reading barcode from photo…';
  const { img } = await fileToImage(f);
  try {
    let code = null;
    if (await hasNativeDetector()) { const c = await new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }).detect(img); if (c.length) code = c[0].rawValue; }
    if (!code) { await loadScript('vendor/zxing.min.js'); const rd = new ZXing.BrowserMultiFormatReader(); try { code = (await rd.decodeFromImageElement(img)).getText(); } catch (e) { } }
    if (code) lookupBarcode(code); else $('#bcStatus').textContent = 'No barcode found in the photo. Try closer, or type the number.';
  } catch (err) { $('#bcStatus').textContent = 'No barcode found. Type the number instead.'; }
};

/* ---------- start ---------- */
async function start() {
  await DB.open();
  S.settings = (await DB.get('settings')) || {};
  const lock = await DB.get('lock');
  if (lock) await showLock('unlock');
  else if (!S.settings.pinAsked) await showLock('first');
  await loadAll();
  const p = new URLSearchParams(location.search);
  setView(p.get('view') || (S.profile.weight ? 'today' : 'me'));
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
}
window.FitLog = { S, DB, lookupBarcode, handleLabel, LabelParse, render };
start();
})();
