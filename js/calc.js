/* Pure calculation helpers (no DOM). */
(function (root) {
  const KCAL_PER_KG = 7700;
  function activityFactor(sessionsPerWeek) {
    const s = Number(sessionsPerWeek) || 0;
    if (s <= 0) return 1.2;
    if (s <= 2) return 1.375;
    if (s <= 4) return 1.55;
    if (s <= 6) return 1.725;
    return 1.9;
  }
  function bmr(p) {
    const w = +p.weight, h = +p.height, a = +p.age;
    if (!w || !h || !a) return 0;
    return 10 * w + 6.25 * h - 5 * a + (p.sex === 'female' ? -161 : 5);
  }
  function targets(p) {
    const B = bmr(p);
    const factor = activityFactor(p.sessions);
    const calcTdee = B * factor;
    // a fixed daily burn estimate (Me → Targets) replaces the BMR × activity estimate everywhere
    const tdee = +p.burnEst > 0 ? +p.burnEst : calcTdee;
    let rate = Math.abs(+p.rate || 0); // kg per week
    let delta = 0;
    if (p.goal === 'lose' || p.goal === 'recomp') delta = -rate * KCAL_PER_KG / 7;
    else if (p.goal === 'gain') delta = rate * KCAL_PER_KG / 7;
    const floor = p.sex === 'female' ? 1200 : 1500;
    let kcal = tdee + delta;
    let floored = false;
    if (B && kcal < floor) { kcal = floor; floored = true; }
    const w = +p.weight || 0;
    const protPerKg = +p.proteinPerKg || (p.goal === 'recomp' ? 2.2 : p.goal === 'lose' ? 2.0 : p.goal === 'gain' ? 1.8 : 1.6);
    const fatPct = +p.fatPct || 27;
    const protein = w * protPerKg;
    const fat = kcal * fatPct / 100 / 9;
    const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
    let weeksToGoal = null;
    const tw = goalWeight(p);
    if (tw && rate && p.goal !== 'maintain') {
      const diff = Math.abs(tw - w);
      weeksToGoal = diff / rate;
    }
    return { bmr: Math.round(B), factor, tdee: Math.round(tdee), calcTdee: Math.round(calcTdee), fixedBurn: +p.burnEst > 0, delta: Math.round(delta),
      kcal: Math.round(kcal), floored, protein: Math.round(protein), fat: Math.round(fat),
      carbs: Math.round(carbs), weeksToGoal, bmi: (w && p.height) ? w / Math.pow(p.height / 100, 2) : 0 };
  }
  // Recomposition: target = starting weight minus the loss goal
  function goalWeight(p) {
    if (p.goal === 'recomp' && +p.startWeight && +p.lossGoal) return Math.round((+p.startWeight - +p.lossGoal) * 10) / 10;
    return +p.targetWeight || 0;
  }
  // "My plan" preset (only applied when the user taps it / enables manual mode with empty fields)
  const PLAN = { mKcal: 1870, mProtMin: 180, mProtMax: 190, mCarbMin: 100, mCarbMax: 130, mFatAuto: true, burnEst: 2450, stepsGoal: 8000, rowGoal: 15, lossGoal: 10,
    weekly: [{ id: 'triceps', name: 'Triceps', min: 60, kcal: 275 }, { id: 'biceps', name: 'Biceps', min: 60, kcal: 275 }, { id: 'shoulders', name: 'Shoulders', min: 60, kcal: 325 }] };
  function autoFat(kcal, pMin, pMax, cMin, cMax) {
    const mid = (kcal - (pMin + pMax) / 2 * 4 - (cMin + cMax) / 2 * 4) / 9;
    return { min: Math.max(0, Math.round(mid - 5)), max: Math.max(0, Math.round(mid + 5)) };
  }
  // what the app actually aims for today: kcal + macro ranges
  function effective(p) {
    const t = targets(p);
    if (p.manual) {
      const kcal = +p.mKcal || t.kcal;
      const pr = { min: +p.mProtMin || 0, max: +p.mProtMax || +p.mProtMin || 0 };
      const cb = { min: +p.mCarbMin || 0, max: +p.mCarbMax || +p.mCarbMin || 0 };
      const fa = p.mFatAuto !== false || !(+p.mFatMin) ? autoFat(kcal, pr.min, pr.max, cb.min, cb.max) : { min: +p.mFatMin, max: +p.mFatMax || +p.mFatMin };
      return { manual: true, kcal: Math.round(kcal), protein: pr, carbs: cb, fat: fa, base: t };
    }
    const band = v => ({ min: Math.round(v * 0.9), max: Math.round(v * 1.1) });
    return { manual: false, kcal: t.kcal, protein: band(t.protein), carbs: band(t.carbs), fat: band(t.fat), base: t };
  }
  function portion(per100, grams) {
    const g = +grams || 0, f = g / 100, out = {};
    for (const k of ['kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'fibre', 'satfat']) {
      if (per100[k] != null && per100[k] !== '') out[k] = Math.round(+per100[k] * f * 10) / 10;
    }
    return out;
  }
  const api = { activityFactor, bmr, targets, portion, effective, autoFat, goalWeight, PLAN, KCAL_PER_KG };
  if (typeof module !== 'undefined') module.exports = api; else root.Calc = api;
})(this);
