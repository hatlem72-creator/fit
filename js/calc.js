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
    const tdee = B * factor;
    let rate = Math.abs(+p.rate || 0); // kg per week
    let delta = 0;
    if (p.goal === 'lose') delta = -rate * KCAL_PER_KG / 7;
    else if (p.goal === 'gain') delta = rate * KCAL_PER_KG / 7;
    const floor = p.sex === 'female' ? 1200 : 1500;
    let kcal = tdee + delta;
    let floored = false;
    if (B && kcal < floor) { kcal = floor; floored = true; }
    const w = +p.weight || 0;
    const protPerKg = +p.proteinPerKg || (p.goal === 'lose' ? 2.0 : p.goal === 'gain' ? 1.8 : 1.6);
    const fatPct = +p.fatPct || 27;
    const protein = w * protPerKg;
    const fat = kcal * fatPct / 100 / 9;
    const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
    let weeksToGoal = null;
    if (p.targetWeight && rate && p.goal !== 'maintain') {
      const diff = Math.abs(+p.targetWeight - w);
      weeksToGoal = diff / rate;
    }
    return { bmr: Math.round(B), factor, tdee: Math.round(tdee), delta: Math.round(delta),
      kcal: Math.round(kcal), floored, protein: Math.round(protein), fat: Math.round(fat),
      carbs: Math.round(carbs), weeksToGoal, bmi: (w && p.height) ? w / Math.pow(p.height / 100, 2) : 0 };
  }
  function portion(per100, grams) {
    const g = +grams || 0, f = g / 100, out = {};
    for (const k of ['kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'fibre', 'satfat']) {
      if (per100[k] != null && per100[k] !== '') out[k] = Math.round(+per100[k] * f * 10) / 10;
    }
    return out;
  }
  const api = { activityFactor, bmr, targets, portion, KCAL_PER_KG };
  if (typeof module !== 'undefined') module.exports = api; else root.Calc = api;
})(this);
