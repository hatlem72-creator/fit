/* Importers for Huawei Health privacy-centre export JSON and simple CSV. */
(function (root) {
  const SPORT = { 2: 'Mountain hike', 3: 'Cycling', 4: 'Running', 5: 'Walking', 101: 'Indoor run', 102: 'Pool swim',
    103: 'Indoor cycling', 104: 'Open-water swim', 111: 'Cross trainer', 117: 'Other workout', 118: 'Trail run',
    145: 'CrossFit', 282: 'Hiking' };
  function ymd(d) { const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function dayFromRecordDay(r) { const s = String(r); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : null; }
  // returns { days: {date:{steps, active}}, workouts: [{date,type,minutes,kcal,start}] }
  function huawei(json) {
    const out = { days: {}, workouts: [], kind: [] };
    const arr = Array.isArray(json) ? json : (json && (json.data || json.list)) || [];
    let sawMinute = false, sawMotion = false;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.sportDataUserData) {
        sawMinute = true;
        const day = dayFromRecordDay(item.recordDay);
        if (!day) continue;
        const byMin = {};
        for (const rec of item.sportDataUserData) {
          const ts = Math.floor((+rec.startTime || 0) / 60000);
          let st = 0, cal = 0;
          for (const b of rec.sportBasicInfos || []) { st += +b.steps || 0; cal += +b.calorie || 0; }
          const m = byMin[ts] || (byMin[ts] = { st: 0, cal: 0 });
          m.st = Math.max(m.st, st); m.cal = Math.max(m.cal, cal);   // phone + watch can both report a minute
        }
        let st = 0, cal = 0;
        for (const m of Object.values(byMin)) { st += m.st; cal += m.cal; }
        const d = out.days[day] || (out.days[day] = { steps: 0, active: 0 });
        d.steps += st; d.active += Math.round(cal / 1000); // calorie is in small calories
      }
      const motions = item.motionPathData ? item.motionPathData : (item.sportType != null && item.totalTime != null ? [item] : []);
      for (const mp of motions) {
        sawMotion = true;
        const start = +mp.startTime;
        if (!start) continue;
        const date = ymd(new Date(start));
        out.workouts.push({ date, type: SPORT[mp.sportType] || ('Sport ' + mp.sportType), minutes: Math.round((+mp.totalTime || 0) / 60000),
          kcal: Math.round((+mp.totalCalories || 0) / 1000), steps: +mp.totalSteps || 0, start, source: 'huawei' });
      }
    }
    if (sawMinute) out.kind.push('daily steps & active calories');
    if (sawMotion) out.kind.push('workouts');
    return out;
  }
  function csv(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (!lines.length) return { days: {}, workouts: [], kind: [] };
    const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const head = lines[0].split(delim).map(h => h.trim().toLowerCase());
    const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
    const ci = { date: col('date', 'dato', 'datum', 'day'), active: col('active', 'aktiv', 'move'), total: col('total'),
      steps: col('step', 'skritt', 'stappen'), type: col('workout', 'type', 'trening', 'sport'), minutes: col('min', 'duration', 'varighet'),
      wkcal: col('workout_kcal', 'workout kcal') };
    const out = { days: {}, workouts: [], kind: ['CSV'] };
    const num = s => { const v = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.')); return isNaN(v) ? null : v; };
    for (const l of lines.slice(1)) {
      const c = l.split(delim).map(s => s.trim().replace(/^"|"$/g, ''));
      let date = c[ci.date] || '';
      let m;
      if ((m = date.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/))) date = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const d = out.days[date] || (out.days[date] = {});
      if (ci.active >= 0 && num(c[ci.active]) != null) d.active = num(c[ci.active]);
      if (ci.total >= 0 && num(c[ci.total]) != null) d.total = num(c[ci.total]);
      if (ci.steps >= 0 && num(c[ci.steps]) != null) d.steps = num(c[ci.steps]);
      if (ci.type >= 0 && c[ci.type]) out.workouts.push({ date, type: c[ci.type], minutes: num(c[ci.minutes]) || 0, kcal: ci.wkcal >= 0 ? num(c[ci.wkcal]) || 0 : 0, source: 'csv' });
    }
    return out;
  }
  const api = { huawei, csv, SPORT };
  if (typeof module !== 'undefined') module.exports = api; else root.Importers = api;
})(this);
