// Gamma engine: one Vercel function. Free CBOE delayed options data in, dealer exposure out.
// GET /api/gex?t=NQ  (NQ = NDX + QQQ options, ES = SPX + SPY options, or any optionable ticker)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RATE = 0.04;            // risk-free rate used in the option maths
const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/";

// What each ticker on the site is made of. Futures views add the futures basis on top.
const BOOKS = {
  NQ: { name: "Nasdaq-100 futures", base: "NDX", parts: [["_NDX", 1], ["QQQ", "ratio"]], fut: "NQ=F", tick: 0.25 },
  ES: { name: "S&P 500 futures", base: "SPX", parts: [["_SPX", 1], ["SPY", "ratio"]], fut: "ES=F", tick: 0.25 },
  SPX: { name: "S&P 500 index", base: "SPX", parts: [["_SPX", 1]] },
  NDX: { name: "Nasdaq-100 index", base: "NDX", parts: [["_NDX", 1]] },
  RUT: { name: "Russell 2000 index", base: "RUT", parts: [["_RUT", 1]] },
  VIX: { name: "VIX", base: "VIX", parts: [["_VIX", 1]] },
};

async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const cache = new Map();
function memo(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), p });
  return p;
}

const chain = (sym) => memo("c:" + sym, 60e3, () => getJSON(CBOE + encodeURIComponent(sym) + ".json"));

async function futPrice(sym) {
  return memo("f:" + sym, 30e3, async () => {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`);
    const m = j.chart.result[0].meta;
    return m.regularMarketPrice || m.chartPreviousClose;
  });
}

// ---------- time ----------
// Offset of New York from UTC on a given day, e.g. -4 in summer, -5 in winter
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" });
function nyOffset(d) {
  const s = NY.formatToParts(d)
    .find((p) => p.type === "timeZoneName").value; // "GMT-4"
  return +(s.replace("GMT", "") || 0);
}
const expCache = new Map();
function expiryTime(yymmdd) {
  if (expCache.has(yymmdd)) return expCache.get(yymmdd);
  const y = 2000 + +yymmdd.slice(0, 2), m = +yymmdd.slice(2, 4) - 1, d = +yymmdd.slice(4, 6);
  const noon = new Date(Date.UTC(y, m, d, 16));
  const t = Date.UTC(y, m, d, 16 - nyOffset(noon)); // 4 PM New York
  expCache.set(yymmdd, t);
  return t;
}

// ---------- option maths (Black-Scholes, no dividends) ----------
const SQ2PI = Math.sqrt(2 * Math.PI);
const pdf = (x) => Math.exp(-x * x / 2) / SQ2PI;
function cdf(x) { // Abramowitz-Stegun
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = k * (0.31938153 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  const v = 1 - pdf(x) * p;
  return x >= 0 ? v : 1 - v;
}
function greeks(S, K, T, iv, call) {
  const v = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (RATE + iv * iv / 2) * T) / v, d2 = d1 - v, n = pdf(d1);
  return {
    gamma: n / (S * v),
    delta: call ? cdf(d1) : cdf(d1) - 1,
    vanna: -n * d2 / iv,                                   // change in delta per 1.00 of vol
    charm: -n * (2 * RATE * T - d2 * v) / (2 * T * v),     // change in delta per year of time passing
  };
}

// ---------- reading the chain ----------
function readChain(j, mult, now) {
  const rows = [];
  for (const o of j.data.options || []) {
    const m = /(\d{6})([CP])(\d{8})$/.exec(o.option || "");
    if (!m) continue;
    const exp = m[1], call = m[2] === "C", K = (+m[3] / 1000) * mult;
    const T = Math.max((expiryTime(exp) - now) / 31536e6, 1 / (365 * 24 * 2)); // at least half an hour
    rows.push({
      exp, call, K, mult, T,
      oi: +o.open_interest || 0, vol: +o.volume || 0, iv: +o.iv || 0,
      bid: +o.bid || 0, ask: +o.ask || 0, last: +o.last_trade_price || 0,
      sym: o.option,
    });
  }
  return rows;
}

// Per 1% move, in dollars. Dealers are assumed long calls and short puts (the standard free model).
function exposure(r, S) {
  if (!r.oi || !r.iv || r.iv <= 0) return null;
  const U = S / r.mult, Ku = r.K / r.mult; // back to the option's own underlying
  const g = greeks(U, Ku, r.T, r.iv, r.call);
  const side = r.call ? 1 : -1, notional = r.oi * 100;
  return {
    gex: side * g.gamma * notional * U * U * 0.01,
    dex: g.delta * notional * U,
    vex: side * g.vanna * notional * U * 0.01,
    cex: side * g.charm * notional * U / 365,
  };
}
function totalGamma(rows, S) {
  // gamma only, the hot loop for the profile
  let t = 0;
  for (const r of rows) {
    if (!r.oi || !r.iv) continue;
    const U = S / r.mult, v = r.v || (r.v = r.iv * Math.sqrt(r.T));
    const d1 = (Math.log(U * r.mult / r.K) + (RATE + r.iv * r.iv / 2) * r.T) / v;
    t += (r.call ? 1 : -1) * Math.exp(-d1 * d1 / 2) / SQ2PI / (U * v) * r.oi * U * U;
  }
  return t; // per 1% move: × 100 contracts × 0.01 cancel out
}
function niceStep(price, rows) {
  const target = price * 0.16 / 60; // about 40–60 rows across ±8%
  const steps = [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500];
  let s = steps.find((x) => x >= target) || 500;
  const listed = [...new Set(rows.map((r) => r.K))].sort((a, b) => a - b).filter((k) => Math.abs(k - price) < price * 0.03);
  let gap = Infinity;
  for (let i = 1; i < listed.length; i++) gap = Math.min(gap, listed[i] - listed[i - 1]);
  if (isFinite(gap) && gap > s) s = steps.find((x) => x >= gap) || s;
  return s;
}
const round = (v, d = 0) => { const f = 10 ** d; return Math.round(v * f) / f; };
const fmtCache = new Map();
const fmtExp = (e) => {
  if (fmtCache.has(e)) return fmtCache.get(e);
  const d = new Date(Date.UTC(2000 + +e.slice(0, 2), +e.slice(2, 4) - 1, +e.slice(4, 6), 12));
  const s = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  fmtCache.set(e, s);
  return s;
};
const isMonthly = (e) => { // third Friday
  const d = new Date(Date.UTC(2000 + +e.slice(0, 2), +e.slice(2, 4) - 1, +e.slice(4, 6)));
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
};

// ---------- the whole picture for one ticker ----------
async function build(ticker) {
  const t = String(ticker || "NQ").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8) || "NQ";
  const book = BOOKS[t] || { name: t, base: t, parts: [[t, 1]] };
  const now = Date.now();

  const first = await chain(book.parts[0][0]);
  const base = first.data.current_price || first.data.close;
  if (!base) throw new Error("No price for " + t);
  let rows = readChain(first, 1, now);
  const sources = [{ sym: book.parts[0][0].replace("_", ""), price: base, n: rows.length }];
  for (const [sym, how] of book.parts.slice(1)) {
    try {
      const j = await chain(sym);
      const p = j.data.current_price || j.data.close;
      const mult = how === "ratio" ? base / p : how;
      const r = readChain(j, mult, now);
      rows = rows.concat(r);
      sources.push({ sym, price: p, n: r.length, ratio: round(mult, 4) });
    } catch (e) { sources.push({ sym, error: String(e.message || e) }); }
  }

  // Futures: show every level in futures points
  let conv = 1, fut = null;
  if (book.fut) {
    try { fut = await futPrice(book.fut); conv = fut / base; } catch (e) { fut = null; }
  }
  const S = base;
  const lo = S * 0.85, hi = S * 1.15;
  rows = rows.filter((r) => r.K >= lo && r.K <= hi);
  if (!rows.length) throw new Error("No options found for " + t);

  // exposures per contract
  for (const r of rows) r.x = exposure(r, S);
  const live = rows.filter((r) => r.x);

  // by strike (bucketed)
  const step = niceStep(S, rows);
  const bucket = (k) => Math.round(k / step) * step;
  const by = new Map();
  for (const r of live) {
    const k = bucket(r.K);
    const b = by.get(k) || { k, cg: 0, pg: 0, dex: 0, vex: 0, cex: 0, coi: 0, poi: 0, cvol: 0, pvol: 0 };
    if (r.call) { b.cg += r.x.gex; b.coi += r.oi; b.cvol += r.vol; } else { b.pg += r.x.gex; b.poi += r.oi; b.pvol += r.vol; }
    b.dex += r.x.dex; b.vex += r.x.vex; b.cex += r.x.cex;
    by.set(k, b);
  }
  const near = [...by.values()].filter((b) => b.k >= S * 0.92 && b.k <= S * 1.08).sort((a, b) => a.k - b.k);
  const all = [...by.values()];

  // walls (whole chain within ±15%)
  let callWall = null, putWall = null;
  for (const b of all) {
    if (!callWall || b.cg > callWall.cg) callWall = b;
    if (!putWall || b.pg < putWall.pg) putWall = b;
  }
  // nearest walls on each side of price, often the more useful intraday levels
  let callNear = null, putNear = null;
  for (const b of all) {
    if (b.k >= S && b.k <= S * 1.04 && (!callNear || b.cg > callNear.cg)) callNear = b;
    if (b.k <= S && b.k >= S * 0.96 && (!putNear || b.pg < putNear.pg)) putNear = b;
  }

  // gamma profile and flip
  const profile = [];
  for (let i = -40; i <= 40; i++) {
    const s = S * (1 + i * 0.0025);
    profile.push([round(s, 2), totalGamma(live, s)]);
  }
  let flip = null;
  for (let i = 1; i < profile.length; i++) {
    const [a, ga] = profile[i - 1], [b, gb] = profile[i];
    if ((ga < 0) !== (gb < 0)) {
      const f = a + (b - a) * (-ga) / (gb - ga);
      if (flip === null || Math.abs(f - S) < Math.abs(flip - S)) flip = f;
    }
  }
  const net = live.reduce((a, r) => a + r.x.gex, 0);
  const totals = live.reduce((a, r) => ({ dex: a.dex + r.x.dex, vex: a.vex + r.x.vex, cex: a.cex + r.x.cex }), { dex: 0, vex: 0, cex: 0 });

  // expiries
  const exps = [...new Set(live.map((r) => r.exp))].sort();
  const front = exps.find((e) => expiryTime(e) > now) || exps[0];
  const shown = exps.filter((e) => expiryTime(e) > now - 864e5).slice(0, 15);
  const byExp = exps.map((e) => {
    const rs = live.filter((r) => r.exp === e);
    return { e, label: fmtExp(e), monthly: isMonthly(e), gex: rs.reduce((a, r) => a + r.x.gex, 0), oi: rs.reduce((a, r) => a + r.oi, 0) };
  });

  // strike × expiry grid (gamma), last column = everything later
  const strikes = near.map((b) => b.k);
  const col = (e) => { const i = shown.indexOf(e); return i < 0 ? shown.length : i; };
  const grid = strikes.map(() => new Array(shown.length + 1).fill(0));
  const gridC = strikes.map(() => new Array(shown.length + 1).fill(0));
  const gridP = strikes.map(() => new Array(shown.length + 1).fill(0));
  for (const r of live) {
    const i = strikes.indexOf(bucket(r.K));
    if (i < 0) continue;
    const j = col(r.exp);
    grid[i][j] += r.x.gex;
    (r.call ? gridC : gridP)[i][j] += r.x.gex;
  }

  // max pain for the front expiry
  const fr = rows.filter((r) => r.exp === front && r.oi && r.mult === 1);
  let maxPain = null;
  if (fr.length) {
    const ks = [...new Set(fr.map((r) => r.K))].filter((k) => k > S * 0.9 && k < S * 1.1);
    let best = Infinity;
    for (const k of ks) {
      let pay = 0;
      for (const r of fr) pay += r.oi * (r.call ? Math.max(0, k - r.K) : Math.max(0, r.K - k)) / r.mult;
      if (pay < best) { best = pay; maxPain = k; }
    }
  }

  // expected move: front expiry at-the-money straddle (own underlying only, so prices are real)
  const own = rows.filter((r) => r.mult === 1);
  const expMove = (e) => {
    const rs = own.filter((r) => r.exp === e);
    if (!rs.length) return null;
    const k = rs.reduce((b, r) => Math.abs(r.K - S) < Math.abs(b - S) ? r.K : b, rs[0].K);
    const mid = (r) => r && (r.bid && r.ask ? (r.bid + r.ask) / 2 : r.last);
    const c = rs.find((r) => r.call && r.K === k), p = rs.find((r) => !r.call && r.K === k);
    const m = (mid(c) || 0) + (mid(p) || 0);
    return m > 0 ? m : null;
  };
  const em = expMove(front);
  const weekly = exps.find((e) => isFridayExp(e) && expiryTime(e) > now);
  const emWeek = weekly && weekly !== front ? expMove(weekly) : null;

  // implied volatility surface: out-of-the-money side, first 10 expiries
  const ivExps = shown.slice(0, 10);
  const ivStrikes = strikes.filter((_, i) => i % 2 === 0);
  const iv = ivStrikes.map((k) => ivExps.map((e) => {
    const rs = own.filter((r) => r.exp === e && Math.abs(r.K - k) <= step && r.iv > 0 && (k >= S ? r.call : !r.call));
    if (!rs.length) return null;
    return round(rs.reduce((a, r) => a + r.iv, 0) / rs.length * 100, 1);
  }));

  // unusual activity: big premium, volume above open interest (delayed day totals, direction unknown)
  const unusual = rows
    .filter((r) => r.vol >= 50)
    .map((r) => {
      const px = r.bid && r.ask ? (r.bid + r.ask) / 2 : r.last;
      const prem = px * r.vol * 100;
      return { sym: r.sym.replace(/^_/, ""), exp: fmtExp(r.exp), call: r.call, K: round(r.K / r.mult, 2), vol: r.vol, oi: r.oi, ratio: r.oi ? round(r.vol / r.oi, 2) : null, prem: round(prem), iv: round(r.iv * 100, 1) };
    })
    .filter((u) => u.prem >= 25000)
    .sort((a, b) => ((b.ratio || 9) >= 1) - ((a.ratio || 9) >= 1) || b.prem - a.prem)
    .slice(0, 30);

  // biggest strikes by absolute net gamma: secondary levels
  const major = [...all].sort((a, b) => Math.abs(b.cg + b.pg) - Math.abs(a.cg + a.pg)).slice(0, 6)
    .map((b) => ({ k: b.k, net: b.cg + b.pg })).sort((a, b) => b.k - a.k);

  const asof = first.timestamp || null;
  return {
    t, name: book.name, base: book.base, price: S, fut, conv: round(conv, 6), futSym: book.fut ? book.fut.replace("=F", "") : null,
    asof, sources, step,
    regime: net >= 0 ? "positive" : "negative",
    net, totals,
    levels: {
      flip: flip && round(flip, 2), callWall: callWall && callWall.k, putWall: putWall && putWall.k,
      callNear: callNear && callNear.k, putNear: putNear && putNear.k,
      maxPain, expMove: em && round(em, 2), expMoveWeek: emWeek && round(emWeek, 2), front: fmtExp(front),
    },
    major,
    strikes: near.map((b) => [b.k, b.cg, b.pg, b.dex, b.vex, b.cex, b.coi, b.poi, b.cvol, b.pvol].map((v) => Math.round(v))),
    exps: shown.map(fmtExp).concat("Later"), grid: rg(grid), gridC: rg(gridC), gridP: rg(gridP),
    byExp: byExp.slice(0, 24),
    profile: profile.map(([a, b]) => [a, Math.round(b)]),
    iv: { exps: ivExps.map(fmtExp), strikes: ivStrikes, z: iv },
    unusual,
    contracts: rows.length,
    updated: new Date().toISOString(),
  };
}
const rg = (g) => g.map((r) => r.map((v) => Math.round(v)));
function isFridayExp(e) {
  return new Date(Date.UTC(2000 + +e.slice(0, 2), +e.slice(2, 4) - 1, +e.slice(4, 6))).getUTCDay() === 5;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const data = await memo("b:" + String(q.t || "NQ").toUpperCase(), 60e3, () => build(q.t));
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).send(JSON.stringify(data));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    const msg = String(e && e.message || e);
    res.status(/^404/.test(msg) ? 404 : 502).send(JSON.stringify({ error: /^404/.test(msg) ? "No options found for that ticker." : "Couldn't load options data: " + msg }));
  }
};
module.exports.build = build;
module.exports.greeks = greeks;
