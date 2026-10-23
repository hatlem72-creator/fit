/* Parse OCR text of a nutrition label into per-100 g values.
   Handles English, Dutch and Norwegian (plus some Swedish/Danish/German) keywords.
   OCR often drops decimal commas ("3,8 g" -> "38g") or reads "g" as 9/8 ("3,8g" -> "389"),
   so every number gets a few candidate readings and the set that best matches the label's
   own energy value (4/4/9 kcal per g) wins. */
(function (root) {
  const SUB = /(mettet|mettede|verzadigd|saturat|umettet|meervoudig|enkelvoudig|trans|polyol|stivelse|zetmeel|starch|hvorav|waarvan|of which|davon|varav|heraf)/i;
  const KEYS = {
    fat: { re: /(\bfat\b|^\W*fa[l1]\b|\bvet\b|\bvetten\b|\bfett\b|\bfedt\b|\bfett\/)/i, excludeSub: true },
    satfat: { re: /(mettede\s*fett|mettet\s*fett|(?<!on)verzadigd|saturate|gesättigte|mættede|mättat)/i },
    carbs: { re: /(karbohydrat|koolhydra|carbohydrate|kolhydrat|kulhydrat|kohlenhydrat)/i, excludeSub: true },
    sugar: { re: /(sukker|suiker|sugar|socker|zucker)/i },
    fibre: { re: /(kostfiber|voedingsvez|vezel|fibre|\bfiber|ballaststoff)/i },
    protein: { re: /(protein|eiwit|eiweiß|eiweiss)/i },
    salt: { re: /(\bsalt\b|\bzout|\bsalz\b)/i }
  };
  function norm(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(/[|\[\]{}]/g, ' ')
      .replace(/(\d)\s?[,·](\d)/g, '$1.$2')   // decimal comma
      .replace(/(\d)\s*\.\s+(\d)/g, '$1.$2')
      .replace(/(?<=\d)[oO]/g, '0')
      .replace(/(?<![A-Za-z])[oO](?=[\d.,]*\s*g\b)/g, '0')     // "Og" -> "0g"
      .replace(/(?<![A-Za-z])[lI](?=\d)/g, '1').replace(/(?<=\d)[lI](?![A-Za-z])/g, '1')
      .replace(/\bk\s*c\s*a\s*l\b/gi, 'kcal').replace(/\bkea[l1]\b/gi, 'kcal').replace(/\bkaal\b/gi, 'kcal').replace(/\bk?cal\b|\bkal\b/gi, 'kcal')
      .replace(/\bk\s*j\b/gi, 'kJ').replace(/(?<=\d\s?)K[jJ]?\b/g, 'kJ');
  }
  function tokens(line) {
    const s = line.replace(/\b(per|pr\.?|pro|je|in)\s*100\s*(g|ml|gram)\b/gi, ' ')
      .replace(/\b100\s*(g|ml)\s*(bevat|inneholder|contains|vare)/gi, ' ')
      .replace(/\d+(\.\d+)?\s*%/g, ' ')
      .replace(/\d+(\.\d+)?\s*(µg|μg|pg|ug)\b/gi, ' ');
    const out = [], re = /(<\s*)?(\d+(?:\.\d+)?)\s*(mg|g\b|kcal|kj)?/gi;
    let m;
    while ((m = re.exec(s))) out.push({ raw: m[2], unit: (m[3] || '').toLowerCase(), lt: !!m[1], unitFirst: /(^|\s)g\b/i.test(s.slice(0, m.index)) });
    return out;
  }
  function tokenFor(lines, i, keyRe) {
    const line = lines[i], km = line.match(keyRe);
    let tk = tokens(km ? line.slice(km.index + km[0].length) : line);
    if (!tk.length && lines[i + 1] && !Object.values(KEYS).some(k => k.re.test(lines[i + 1]))) tk = tokens(lines[i + 1]);
    if (!tk.length) return null;
    const t = tk[0];
    if (tk[1]) t.alt = tk[1];
    return t;
  }
  // candidate readings of one OCR token: [{v, mods}]
  function candidates(t) {
    if (!t) return [];
    let extra = [];
    if (t.alt) { const a = { ...t.alt }; delete a.alt; extra = candidates(a).map(c => ({ v: c.v, mods: c.mods + (/^[089]$/.test(t.raw) ? 0.5 : 2) })); }
    const out = extra.slice(), add = (v, mods) => { if (v >= 1 && Math.abs(v * 10 - Math.round(v * 10)) > 1e-6) mods += 1; if (v === 0) mods += 0.3; if (v >= 0 && v <= 100 && !out.some(o => Math.abs(o.v - v) < 1e-9 && o.mods <= mods)) out.push({ v: Math.round(v * 1000) / 1000, mods }); };
    const scale = t.unit === 'mg' ? 1 / 1000 : 1;
    const noUnit = !t.unit && !t.unitFirst;
    if (t.raw.includes('.')) {
      const ends = noUnit && /[89]$/.test(t.raw) && t.raw.length > 2;
      if (ends) { const b = t.raw.slice(0, -1).replace(/\.$/, ''); add(parseFloat(b), 0.5); }
      add(parseFloat(t.raw) * scale, ends ? 1 : 0);
      return out;
    }
    const variants = [[t.raw, 0]];
    if (t.raw.length >= 3 && t.raw[0] === '1') variants.push([t.raw.slice(1), 1]);
    if (t.raw.length >= 4 && t.raw[0] === '1' && noUnit && /[89]$/.test(t.raw)) variants.push([t.raw.slice(1, -1), 1.5]);
    if (noUnit && t.raw.length >= 2 && /[89]$/.test(t.raw)) variants.push([t.raw.slice(0, -1), 0.5]);
    if (noUnit && t.raw.length >= 3 && /[89]$/.test(t.raw)) variants.push([t.raw.slice(0, -2), 2]);
    for (const [d, m0] of variants) {
      if (!d) continue;
      if (d.length >= 2 && d[0] === '0') { add(+d / Math.pow(10, d.length - 1) * scale, m0 + 1); continue; }
      add(+d * scale, m0);
      if (d.length >= 2) add(+d / 10 * scale, m0 + 1);
      if (d.length >= 3) add(+d / 100 * scale, m0 + 1);
    }
    return out;
  }
  function energy(text) {
    const kcal = [], kj = [];
    for (const L of text.split('\n')) {
      if (/refer|inname|intake|inntak|8400|2000\s*kcal|dagelijks|daglig/i.test(L)) continue;
      for (const m of L.matchAll(/(\d{1,4}(?:\.\d+)?)[ \t]*kcal/gi)) kcal.push(parseFloat(m[1]));
      for (const m of L.matchAll(/kcal[ \t),.]*[:\-]?[ \t]*(\d{1,4}(?:\.\d+)?)/gi)) kcal.push(parseFloat(m[1]));
      for (const m of L.matchAll(/(\d{2,5}(?:\.\d+)?)[ \t]*kJ/gi)) kj.push(parseFloat(m[1]));
      for (const m of L.matchAll(/kJ[ \t),.]*[:\-]?[ \t]*(\d{2,5}(?:\.\d+)?)/gi)) kj.push(parseFloat(m[1]));
    }
    return { kcal: kcal.filter(v => v >= 1 && v <= 900), kj: kj.filter(v => v >= 4 && v <= 3800) };
  }
  function scan(raw) {
    const text = norm(raw);
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const tok = {};
    for (const [key, def] of Object.entries(KEYS)) {
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        if (!def.re.test(L)) continue;
        if (def.excludeSub && SUB.test(L)) continue;
        if (key === 'fat' && KEYS.satfat.re.test(L)) continue;
        const t = tokenFor(lines, i, def.re);
        if (t) { tok[key] = t; break; }
      }
    }
    if (!tok.salt) {
      const i = lines.findIndex(l => /natrium|sodium/i.test(l));
      if (i >= 0) { const t = tokenFor(lines, i, /natrium|sodium/i); if (t) tok.sodium = t; }
    }
    const e = energy(text);
    const basis = /100\s*ml/i.test(text) && !/100\s*g\b/i.test(text) ? '100ml' : '100g';
    return { tok, e, basis };
  }
  function pickEnergy(es) {
    const kc = es.flatMap(e => e.kcal), kj = es.flatMap(e => e.kj);
    for (const c of kc) for (const j of kj) if (Math.abs(j / 4.184 - c) <= Math.max(4, c * 0.04)) return { kcal: c, kj: j, sure: true };
    if (kj.length) return { kcal: Math.round(kj[0] / 4.184), kj: kj[0] };
    if (kc.length) return { kcal: kc[0], kj: null };
    return { kcal: null, kj: null };
  }
  function merge(lists) { const out = []; for (const l of lists) for (const c of l) { const o = out.find(x => Math.abs(x.v - c.v) < 1e-9); if (!o) out.push({ ...c }); else o.mods = Math.min(o.mods, c.mods); } return out; }
  function parseMany(texts) {
    const scans = texts.map(scan);
    const en = pickEnergy(scans.map(s => s.e));
    const C = {};
    for (const k of ['fat', 'satfat', 'carbs', 'sugar', 'fibre', 'protein', 'salt', 'sodium']) C[k] = merge(scans.map(s => candidates(s.tok[k])));
    const res = { kcal: en.kcal, kj: en.kj, fat: null, satfat: null, carbs: null, sugar: null, fibre: null, protein: null, salt: null,
      basis: scans.some(s => s.basis === '100ml') ? '100ml' : '100g', found: [], fixed: [] };
    const opt = k => C[k].length ? C[k] : [{ v: null, mods: 0 }];
    let best = null;
    for (const f of opt('fat')) for (const c of opt('carbs')) for (const p of opt('protein')) for (const fb of opt('fibre')) {
      const sum = (f.v || 0) + (c.v || 0) + (p.v || 0) + (fb.v || 0);
      if (sum > 101) continue;
      const mods = f.mods + c.mods + p.mods + fb.mods;
      let score = mods * 6 + ((fb.v || 0) > 15 ? 4 : 0);
      const known = f.v != null && c.v != null && p.v != null;
      if (en.kcal != null && known) {
        const est = f.v * 9 + c.v * 4 + p.v * 4 + (fb.v || 0) * 2;
        score += Math.abs(est - en.kcal) / Math.max(en.kcal, 40) * 100;
      }
      if (!best || score < best.score) best = { score, f, c, p, fb };
    }
    if (best) { res.fat = best.f.v; res.carbs = best.c.v; res.protein = best.p.v; res.fibre = best.fb.v;
      for (const [k, o] of [['fat', best.f], ['carbs', best.c], ['protein', best.p], ['fibre', best.fb]]) if (o.mods) res.fixed.push(k); }
    const sub = (k, max) => { const cs = C[k].filter(c => max == null || c.v <= max + 0.05).sort((a, b) => a.mods - b.mods || b.v - a.v); if (cs.length) { res[k] = cs[0].v; if (cs[0].mods) res.fixed.push(k); } };
    sub('satfat', res.fat); sub('sugar', res.carbs);
    const sc = C.salt.length ? C.salt : C.sodium.map(c => ({ v: Math.round(c.v * 2.5 * 100) / 100, mods: c.mods }));
    const sl = sc.filter(c => c.v <= 25).sort((a, b) => (a.mods + (a.v > 6 ? 2 : 0)) - (b.mods + (b.v > 6 ? 2 : 0)));
    if (sl.length) { res.salt = sl[0].v; if (sl[0].mods) res.fixed.push('salt'); }
    for (const k of ['kcal', 'fat', 'satfat', 'carbs', 'sugar', 'fibre', 'protein', 'salt']) if (res[k] != null) res.found.push(k);
    for (const k of ['fat', 'satfat', 'carbs', 'sugar', 'fibre', 'protein', 'salt']) if (res[k] != null) res[k] = Math.round(res[k] * 100) / 100;
    if (res.kcal && res.fat != null && res.carbs != null && res.protein != null) {
      const est = res.fat * 9 + res.carbs * 4 + res.protein * 4 + (res.fibre || 0) * 2;
      res.check = Math.round(est); res.checkOk = Math.abs(est - res.kcal) <= Math.max(25, res.kcal * 0.2);
      res.tight = Math.abs(est - res.kcal) <= Math.max(12, res.kcal * 0.07);
    }
    return res;
  }
  const api = { parse: t => parseMany([t]), parseMany, norm, scan };
  if (typeof module !== 'undefined') module.exports = api; else root.LabelParse = api;
})(this);
