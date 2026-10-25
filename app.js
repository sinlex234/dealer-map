// Dealer Map: front end. Plain JavaScript, no build step. Charts by Plotly.

const TICKERS = ['NQ', 'ES', 'SPX', 'NDX', 'SPY', 'QQQ', 'IWM'];
const main = document.getElementById('main');
const S = { t: 'NQ', d: null, units: 'fut', view: 'strike', mode: 'split', exp: 'all', greek: 'dex', iv: 'surface', timer: null };
try { Object.assign(S, JSON.parse(localStorage.getItem('dm-view') || '{}'), { d: null, timer: null }); } catch (e) {}
const save = () => { try { const { units, view, mode, greek, iv } = S; localStorage.setItem('dm-view', JSON.stringify({ units, view, mode, greek, iv })); } catch (e) {} };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const money = (v) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '+';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
};
const conv = () => (S.d && S.d.futSym && S.units === 'fut' ? S.d.conv : 1);
const unit = () => (S.d && S.d.futSym && S.units === 'fut' ? S.d.futSym : S.d ? S.d.base : '');
const dec = () => (S.d && S.d.price < 500 ? 2 : S.d && S.d.price < 5000 ? 1 : 0);
const lvl = (v) => (v == null ? '—' : (v * conv()).toLocaleString('en-US', { minimumFractionDigits: dec(), maximumFractionDigits: dec() }));
const lvlRaw = (v) => {
  if (v == null) return null;
  const x = v * conv(), tick = S.d.futSym && S.units === 'fut' ? 0.25 : S.d.price < 500 ? 0.01 : 0.05;
  return +(Math.round(x / tick) * tick).toFixed(2);
};
const price = () => (S.d.futSym && S.units === 'fut' && S.d.fut ? S.d.fut : S.d.price);
const pct = (v) => (v == null ? '' : `${v >= S.d.price ? '+' : '−'}${Math.abs((v - S.d.price) / S.d.price * 100).toFixed(2)}% away`);
const C = () => ({ ink: css('--ink'), ink2: css('--ink-2'), ink3: css('--ink-3'), rule: css('--rule'), panel: css('--panel'), pos: css('--pos'), neg: css('--neg'), flip: css('--flip'), acc: css('--acc'), mono: css('--mono') });
const cfg = { displayModeBar: false, responsive: true };

function baseLayout(c, extra = {}) {
  return {
    paper_bgcolor: c.panel, plot_bgcolor: c.panel, font: { family: c.mono, size: 11, color: c.ink2 },
    margin: { l: 64, r: 18, t: 12, b: 40 }, showlegend: false, hoverlabel: { bgcolor: c.panel, bordercolor: c.rule, font: { family: c.mono, color: c.ink } },
    ...extra,
  };
}
const hLine = (y, color, dash = 'dot') => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1.2, dash } });
const vLine = (x, color, dash = 'dot') => ({ type: 'line', yref: 'paper', y0: 0, y1: 1, x0: x, x1: x, line: { color, width: 1.2, dash } });
const hTag = (y, text, color) => ({ xref: 'paper', x: 1, y, text, showarrow: false, xanchor: 'right', yanchor: 'bottom', font: { size: 11, color } });

// ---------- data ----------
async function load(t, quiet) {
  if (!quiet) main.innerHTML = '<p class="loading">Loading options data…</p>';
  try {
    const r = await fetch('/api/gex?t=' + encodeURIComponent(t));
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'The data service didn\'t answer.');
    S.d = d; S.t = d.t;
    render();
  } catch (e) {
    if (quiet && S.d) return; // keep the last good picture
    main.innerHTML = `<div class="err"><b>Couldn't load ${esc(t)}</b>${esc(e.message)} Check the ticker, or try again in a minute.</div>`;
  }
  nav();
}

function nav() {
  const box = document.getElementById('tickers');
  box.innerHTML = TICKERS.map((t) => `<a href="/?t=${t}" data-t="${t}" ${t === S.t ? 'aria-current="page"' : ''}>${t}</a>`).join('')
    + (TICKERS.includes(S.t) ? '' : `<a href="/?t=${esc(S.t)}" data-t="${esc(S.t)}" aria-current="page">${esc(S.t)}</a>`);
  box.querySelectorAll('a').forEach((a) => a.onclick = (e) => { e.preventDefault(); go(a.dataset.t); });
}
function go(t) {
  t = String(t || '').toUpperCase().trim();
  if (!t) return;
  history.pushState(null, '', '/?t=' + encodeURIComponent(t));
  S.exp = 'all';
  S.t = t; nav(); load(t);
}

// ---------- page ----------
function render() {
  const d = S.d, c = C();
  const fut = !!d.futSym;
  const L = d.levels;
  const reg = d.regime === 'positive';
  document.title = `${d.t} gamma levels | Dealer Map`;
  const when = d.asof ? new Date(d.asof.replace(' ', 'T') + 'Z') : null;

  main.innerHTML = `
  <div class="head">
    <div>
      <p class="eyebrow">${esc(d.name)} <span class="pill ${reg ? 'pos' : 'neg'} live">${reg ? 'Positive' : 'Negative'} gamma</span></p>
      <h1>${esc(d.t)} <span class="px">${lvlPrice()}</span></h1>
      <p class="sub">${reg
        ? 'Dealers are long gamma: they sell rallies and buy dips, which calms price down. Expect ranges, and fades at the walls.'
        : 'Dealers are short gamma: they sell drops and buy rallies, which makes moves bigger. Expect trends and breakouts, and respect momentum.'}
        Net gamma ${money(d.net)} per 1% move.</p>
    </div>
    <div class="tools">
      ${fut ? `<div class="units" role="group" aria-label="Show levels in">
        <button type="button" data-u="fut" aria-pressed="${S.units === 'fut'}">${esc(d.futSym)} points</button>
        <button type="button" data-u="base" aria-pressed="${S.units === 'base'}">${esc(d.base)} points</button></div>` : ''}
      <span class="stamp">Options as of ${when ? esc(fmtTime(d.asof)) : 'last update'} · 15 min delay</span>
    </div>
  </div>

  <div class="levels">
    ${lvCard('Gamma flip', L.flip, 'flip', L.flip ? pct(L.flip) : 'No flip within ±10%')}
    ${lvCard('Call wall', L.callWall, 'call', L.callNear && L.callNear !== L.callWall ? `Nearest: ${lvl(L.callNear)}` : pct(L.callWall))}
    ${lvCard('Put wall', L.putWall, 'put', L.putNear && L.putNear !== L.putWall ? `Nearest: ${lvl(L.putNear)}` : pct(L.putWall))}
    ${lvCard('Max pain', L.maxPain, '', esc(L.front) + ' expiry')}
    <div class="lv"><small>Expected move</small><b>${L.expMove ? '±' + (L.expMove * conv()).toFixed(dec()) : '—'}</b><span>${L.expMove ? `${lvl(d.price - L.expMove)} to ${lvl(d.price + L.expMove)}` : 'No straddle price'}</span></div>
    <div class="lv"><small>This week</small><b>${L.expMoveWeek ? '±' + (L.expMoveWeek * conv()).toFixed(dec()) : '—'}</b><span>${L.expMoveWeek ? `${lvl(d.price - L.expMoveWeek)} to ${lvl(d.price + L.expMoveWeek)}` : 'Friday straddle'}</span></div>
  </div>

  <div class="reads">${reads()}</div>

  <section class="panel">
    <div class="panel-h">
      <h2>${{ strike: 'Gamma by strike', heat: 'Gamma by strike and expiry', '3d': 'Gamma surface', profile: 'Where the regime flips' }[S.view]}</h2>
      <div class="tools">
        <div class="seg" role="group" aria-label="Chart">
          ${[['strike', 'By strike'], ['heat', 'Heatmap'], ['3d', '3D'], ['profile', 'Profile']].map(([k, n]) => `<button type="button" data-view="${k}" aria-pressed="${S.view === k}">${n}</button>`).join('')}
        </div>
        ${S.view === 'strike' ? `<div class="seg" role="group" aria-label="Bars">
          <button type="button" data-mode="split" aria-pressed="${S.mode === 'split'}">Calls and puts</button>
          <button type="button" data-mode="net" aria-pressed="${S.mode === 'net'}">Net</button></div>
          <label class="sr" for="expSel">Expiry</label>
          <select id="expSel">${['<option value="all">All expiries</option>'].concat(d.exps.map((e, i) => `<option value="${i}" ${String(S.exp) === String(i) ? 'selected' : ''}>${esc(e)}</option>`)).join('')}</select>` : ''}
      </div>
    </div>
    <p class="panel-n">${{
      strike: 'How much hedging dealers must do at each strike. Teal bars (calls) tend to hold price like a magnet or ceiling; rose bars (puts) are where moves can speed up.',
      heat: 'Each cell is one strike for one expiry. It shows which levels expire soon (and disappear) and which stay. "Later" adds up everything after the last column.',
      '3d': 'The same map as the heatmap, in 3D. Spikes are the strikes and expiries dealers care about most. Drag to turn it.',
      profile: 'Total dealer gamma if price moved to each level. Above zero, dealers calm price down; below zero, they push it further. It crosses zero at the gamma flip.',
    }[S.view]}</p>
    <div class="plot" id="pMain"></div>
  </section>

  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h2>Other exposures</h2>
        <div class="seg" role="group" aria-label="Exposure">
          ${[['dex', 'Delta'], ['vex', 'Vanna'], ['cex', 'Charm']].map(([k, n]) => `<button type="button" data-greek="${k}" aria-pressed="${S.greek === k}">${n}</button>`).join('')}
        </div></div>
      <p class="panel-n">${{
        dex: `Delta: how many dollars of the index the options are worth, by strike. Total ${money(d.totals.dex)}.`,
        vex: `Vanna: how dealer hedging changes when volatility moves 1 point. When volatility falls, positive vanna means dealers buy. Total ${money(d.totals.vex)}.`,
        cex: `Charm: how dealer hedging changes as one day passes. It drives the drift into the close and into expiry. Total ${money(d.totals.cex)} per day.`,
      }[S.greek]}</p>
      <div class="plot mid" id="pGreek"></div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Gamma by expiry</h2></div>
      <p class="panel-n">Which expiries hold the most gamma. Darker bars are the monthly expiries, which usually carry the big walls.</p>
      <div class="plot mid" id="pExp"></div>
    </section>
  </div>

  <section class="panel">
    <div class="panel-h"><h2>Implied volatility</h2>
      <div class="seg" role="group" aria-label="Volatility chart">
        <button type="button" data-iv="surface" aria-pressed="${S.iv === 'surface'}">3D surface</button>
        <button type="button" data-iv="smile" aria-pressed="${S.iv === 'smile'}">Smile</button>
      </div></div>
    <p class="panel-n">How expensive options are at each strike and expiry (out-of-the-money side). A steep left side means traders are paying up for crash protection.</p>
    <div class="plot mid" id="pIV"></div>
  </section>

  <section class="panel">
    <div class="panel-h"><h2>Unusual options activity</h2><span class="stamp">Today's totals so far, delayed</span></div>
    <p class="panel-n">Contracts with big premium, where today's volume is at or above open interest (new positions). The free data can't tell buys from sells, so read it as "where the action is", not as direction.</p>
    <div class="tbl-wrap">${unusualTable()}</div>
  </section>

  <section class="panel">
    <div class="panel-h"><h2>Put these levels on TradingView</h2></div>
    <p class="panel-n">Copy the list for alerts, or paste the script into TradingView's Pine Editor (Add to chart). Levels change every day, so paste again each morning.</p>
    <div class="export">
      <div><ul class="lvl-list">${exportLevels().map(([n, v]) => `<li><i>${esc(n)}</i><span>${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></li>`).join('')}</ul>
        <div class="btn-row"><button class="btn" type="button" id="copyList">Copy levels</button><span class="ok" id="copyListOk" aria-live="polite"></span></div></div>
      <div><pre id="pine">${esc(pine())}</pre>
        <div class="btn-row"><button class="btn" type="button" id="copyPine">Copy script</button><span class="ok" id="copyPineOk" aria-live="polite"></span></div></div>
    </div>
  </section>

  <section class="panel">
    <details class="how"><summary>How to read this page</summary>
      <dl>
        <dt>Gamma</dt><dd>How fast an option's delta changes. Dealers who sold options must keep re-hedging, and gamma says how much.</dd>
        <dt>Positive gamma</dt><dd>Dealers sell when price rises and buy when it falls. Moves get absorbed, so days tend to range.</dd>
        <dt>Negative gamma</dt><dd>Dealers sell when price falls and buy when it rises. Moves feed themselves, so days tend to trend.</dd>
        <dt>Gamma flip</dt><dd>The price where total gamma crosses zero. Above it, calm; below it, wilder.</dd>
        <dt>Call wall</dt><dd>The strike with the most call gamma. Often a ceiling or a magnet.</dd>
        <dt>Put wall</dt><dd>The strike with the most put gamma. Often a floor, but if it breaks, selling can speed up.</dd>
        <dt>Max pain</dt><dd>The price where the nearest expiry's options would pay out the least. Price sometimes drifts toward it into expiry.</dd>
        <dt>Expected move</dt><dd>What the at-the-money straddle prices in for that expiry. About two days in three stay inside it.</dd>
        <dt>${esc(d.futSym || d.base)} conversion</dt><dd>${fut ? `Levels come from ${esc(d.sources.map((s) => s.sym).join(' and '))} options, converted to ${esc(d.futSym)} by today's ratio (${d.conv.toFixed(4)}) so they line up with the futures chart.` : 'Levels are in the underlying\'s own prices.'}</dd>
      </dl>
    </details>
  </section>`;

  bind();
  draw();
}

function lvlPrice() { return lvl(price() / conv()); }
function lvCard(name, v, cls, sub) {
  return `<div class="lv ${cls}"><small>${name}</small><b>${lvl(v)}</b><span>${sub}</span></div>`;
}
function fmtTime(s) {
  // CBOE gives New York time without a zone
  const [dpart, tpart] = s.split(' ');
  const [y, m, d] = dpart.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${tpart.slice(0, 5)} ET`;
}

function reads() {
  const d = S.d, L = d.levels;
  const out = [];
  if (L.flip) {
    const above = d.price > L.flip, dist = Math.abs(d.price - L.flip) / d.price * 100;
    out.push(['flip', above ? `Price is ${dist.toFixed(1)}% above the flip` : `Price is ${dist.toFixed(1)}% below the flip`,
      `${lvl(L.flip)} is the line between calm and wild. ${dist < 0.6 ? 'It\'s close, so the regime can change today: watch how price behaves around it.' : above ? 'Losing it would switch dealers to chasing moves.' : 'Getting back above it would calm things down.'}`]);
  }
  // how much of the gamma near price is in the first expiry
  const tot = d.grid.reduce((a, r) => a + r.reduce((x, v) => x + Math.abs(v), 0), 0);
  const first = d.grid.reduce((a, r) => a + Math.abs(r[0]), 0);
  if (tot) out.push([d.regime === 'positive' ? 'pos' : 'neg', `${Math.round(first / tot * 100)}% of nearby gamma expires ${d.exps[0]}`,
    first / tot > 0.35 ? 'A big share of today\'s levels comes from the nearest expiry. They can move or vanish after it settles, so re-check them the next morning.' : 'Most of the gamma sits in later expiries, so these levels should hold for a while.']);
  if (L.expMove) {
    const hi = d.price + L.expMove, lo = d.price - L.expMove;
    const inC = L.callWall && L.callWall <= hi, inP = L.putWall && L.putWall >= lo;
    out.push(['', `Expected range ${lvl(lo)} to ${lvl(hi)}`,
      inC && inP ? 'Both walls sit inside the expected move, so price can test either side.' : inC ? 'The call wall is inside the expected move: a likely test if price rises.' : inP ? 'The put wall is inside the expected move: a likely test if price falls.' : 'Both walls are outside the expected move, so they matter more for the week than for today.']);
  }
  return out.map(([cls, h, p]) => `<div class="read ${cls}"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('');
}

function unusualTable() {
  const u = S.d.unusual.slice(0, 15);
  if (!u.length) return '<p class="panel-n" style="padding-bottom:16px">Nothing unusual yet today.</p>';
  return `<table><thead><tr><th>Contract</th><th>Expiry</th><th>Strike</th><th>Volume</th><th>Open int.</th><th>Vol / OI</th><th>IV</th><th>Premium</th></tr></thead><tbody>
    ${u.map((x) => `<tr><td><span class="${x.call ? 'c' : 'p'}">${x.call ? 'Call' : 'Put'}</span> ${esc(x.sym.replace(/\d{6}[CP]\d{8}$/, ''))}</td><td>${esc(x.exp)}</td><td>${x.K.toLocaleString('en-US')}</td><td>${x.vol.toLocaleString('en-US')}</td><td>${x.oi.toLocaleString('en-US')}</td><td class="${x.ratio >= 1 ? 'hot' : ''}">${x.ratio ?? '—'}</td><td>${x.iv}%</td><td>${money(x.prem).replace('+', '')}</td></tr>`).join('')}
  </tbody></table>`;
}

function exportLevels() {
  const d = S.d, L = d.levels, out = [];
  const add = (n, v) => { if (v != null && !out.some((o) => Math.abs(o[1] - lvlRaw(v)) < 1e-9)) out.push([n, lvlRaw(v)]); };
  add('Call wall', L.callWall); add('Put wall', L.putWall); add('Gamma flip', L.flip);
  add('Nearest call wall', L.callNear); add('Nearest put wall', L.putNear); add('Max pain', L.maxPain);
  if (L.expMove) { add('Expected move high', d.price + L.expMove); add('Expected move low', d.price - L.expMove); }
  d.major.forEach((m) => add(`Big gamma strike (${m.net >= 0 ? 'calls' : 'puts'})`, m.k));
  return out.sort((a, b) => b[1] - a[1]);
}
function pine() {
  const d = S.d, date = (d.asof || d.updated).slice(0, 10);
  const col = (n) => /Call/.test(n) || /calls/.test(n) ? 'color.teal' : /Put|puts/.test(n) ? 'color.red' : /flip/.test(n) ? 'color.orange' : 'color.gray';
  const lines = exportLevels().map(([n, v]) => `hline(${v}, "${n}", color=${col(n)}, linestyle=${/Big|Expected/.test(n) ? 'hline.style_dotted' : 'hline.style_dashed'}, linewidth=${/wall|flip/.test(n) && !/Nearest/.test(n) ? 2 : 1})`);
  return `//@version=5\nindicator("${unit()} gamma levels ${date}", overlay=true)\n${lines.join('\n')}`;
}

// ---------- charts ----------
function draw() {
  const d = S.d, c = C(), k = conv();
  const L = d.levels;
  const strikes = d.strikes.map((r) => r[0] * k);
  const lo = Math.min(...strikes), hi = Math.max(...strikes);
  const marks = [
    { v: price(), color: c.ink, name: 'Price', dash: 'solid' },
    { v: L.flip && L.flip * k, color: c.flip, name: 'Flip', dash: 'dot' },
    { v: L.callWall * k, color: c.pos, name: 'Call wall', dash: 'dot' },
    { v: L.putWall * k, color: c.neg, name: 'Put wall', dash: 'dot' },
  ].filter((m) => m.v && m.v >= lo && m.v <= hi);
  const fmtV = (v) => v.toLocaleString('en-US', { maximumFractionDigits: dec() });
  const yax = { color: c.ink3, gridcolor: c.rule, tickformat: ',', title: { text: unit(), font: { size: 11 } }, zeroline: false };

  if (S.view === 'strike') {
    let calls, puts, net;
    if (S.exp === 'all') { calls = d.strikes.map((r) => r[1]); puts = d.strikes.map((r) => r[2]); }
    else { const j = +S.exp; calls = d.gridC.map((r) => r[j]); puts = d.gridP.map((r) => r[j]); }
    net = calls.map((v, i) => v + puts[i]);
    const hov = (name) => `${name} %{y:,.${dec()}f}<br>%{customdata}<extra></extra>`;
    const traces = S.mode === 'split'
      ? [{ type: 'bar', orientation: 'h', y: strikes, x: calls.map((v) => v / 1e6), customdata: calls.map(money), marker: { color: c.pos }, hovertemplate: hov('Calls') },
         { type: 'bar', orientation: 'h', y: strikes, x: puts.map((v) => v / 1e6), customdata: puts.map(money), marker: { color: c.neg }, hovertemplate: hov('Puts') }]
      : [{ type: 'bar', orientation: 'h', y: strikes, x: net.map((v) => v / 1e6), customdata: net.map(money), marker: { color: net.map((v) => (v >= 0 ? c.pos : c.neg)) }, hovertemplate: hov('Net') }];
    Plotly.react('pMain', traces, baseLayout(c, {
      barmode: 'relative', bargap: 0.18,
      xaxis: { color: c.ink3, gridcolor: c.rule, ticksuffix: 'M', zerolinecolor: c.ink3, title: { text: '$ per 1% move', font: { size: 11 } } },
      yaxis: yax,
      shapes: marks.map((m) => hLine(m.v, m.color, m.dash)), annotations: marks.map((m) => hTag(m.v, `${m.name} ${fmtV(m.v)}`, m.color)),
    }), cfg);
  } else if (S.view === 'heat' || S.view === '3d') {
    const z = d.grid.map((r) => r.map((v) => v / 1e6));
    const flat = z.flat().map(Math.abs).sort((a, b) => a - b);
    const lim = Math.max(1, flat[Math.floor(flat.length * 0.97)] || 1);
    const scale = [[0, c.neg], [0.5, c.panel], [1, c.pos]];
    const hov = `Strike %{y:,.${dec()}f}<br>%{x}<br>%{z:,.1f}M per 1%<extra></extra>`;
    if (S.view === 'heat') {
      Plotly.react('pMain', [{ type: 'heatmap', x: d.exps, y: strikes, z, colorscale: scale, zmin: -lim, zmax: lim, zmid: 0, xgap: 1, ygap: 1, hovertemplate: hov,
        colorbar: { thickness: 8, outlinewidth: 0, ticksuffix: 'M', tickfont: { color: c.ink3 } } }],
        baseLayout(c, { margin: { l: 64, r: 10, t: 12, b: 64 }, xaxis: { color: c.ink3, tickangle: -35, gridcolor: c.rule }, yaxis: yax,
          shapes: marks.map((m) => hLine(m.v, m.color, m.dash)) }), cfg);
    } else {
      Plotly.react('pMain', [{ type: 'surface', x: d.exps, y: strikes, z, colorscale: scale, cmin: -lim, cmax: lim, cmid: 0, showscale: false, hovertemplate: hov,
        lighting: { ambient: 0.75, diffuse: 0.6, specular: 0.15 } }],
        baseLayout(c, { margin: { l: 0, r: 0, t: 0, b: 0 }, scene: {
          bgcolor: c.panel, camera: { eye: { x: 1.25, y: -1.2, z: 0.75 } }, aspectratio: { x: 1.2, y: 1.5, z: 0.75 },
          xaxis: { title: { text: 'Expiry' }, color: c.ink3, gridcolor: c.rule, showbackground: false },
          yaxis: { title: { text: unit() }, color: c.ink3, gridcolor: c.rule, showbackground: false, tickformat: ',' },
          zaxis: { title: { text: '$M per 1%' }, color: c.ink3, gridcolor: c.rule, showbackground: false } } }), cfg);
    }
  } else {
    const x = d.profile.map((p) => p[0] * k), y = d.profile.map((p) => p[1] / 1e9);
    Plotly.react('pMain', [
      { x, y: y.map((v) => Math.min(v, 0)), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tozeroy', fillcolor: hexA(c.neg, 0.18), hoverinfo: 'skip' },
      { x, y: y.map((v) => Math.max(v, 0)), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tozeroy', fillcolor: hexA(c.pos, 0.18), hoverinfo: 'skip' },
      { x, y, type: 'scatter', mode: 'lines', line: { color: c.ink, width: 2 }, hovertemplate: `${unit()} %{x:,.${dec()}f}<br>%{y:.2f}B per 1%<extra></extra>` },
    ], baseLayout(c, {
      margin: { l: 56, r: 18, t: 26, b: 44 },
      xaxis: { color: c.ink3, gridcolor: c.rule, tickformat: ',', zeroline: false, title: { text: unit(), font: { size: 11 } } },
      yaxis: { color: c.ink3, gridcolor: c.rule, ticksuffix: 'B', zerolinecolor: c.ink3 },
      shapes: marks.filter((m) => m.name === 'Price' || m.name === 'Flip').map((m) => vLine(m.v, m.color, m.dash)),
      annotations: marks.filter((m) => m.name === 'Price' || m.name === 'Flip').map((m) => ({ x: m.v, y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false, text: `${m.name} ${fmtV(m.v)}`, font: { size: 11, color: m.color } })),
    }), cfg);
  }

  // other exposures
  const gi = { dex: 3, vex: 4, cex: 5 }[S.greek];
  const gv = d.strikes.map((r) => r[gi]);
  Plotly.react('pGreek', [{ type: 'bar', orientation: 'h', y: strikes, x: gv.map((v) => v / 1e6), customdata: gv.map(money),
    marker: { color: gv.map((v) => (v >= 0 ? c.pos : c.neg)) }, hovertemplate: `%{y:,.${dec()}f}: %{customdata}<extra></extra>` }],
    baseLayout(c, { bargap: 0.18, xaxis: { color: c.ink3, gridcolor: c.rule, ticksuffix: 'M', zerolinecolor: c.ink3 }, yaxis: yax,
      shapes: [hLine(price(), c.ink, 'solid')] }), cfg);

  // by expiry
  const be = d.byExp.slice(0, 16);
  Plotly.react('pExp', [{ type: 'bar', x: be.map((e) => e.label.replace(/^\w+, /, '')), y: be.map((e) => e.gex / 1e9), customdata: be.map((e) => `${e.label}${e.monthly ? ' (monthly)' : ''}<br>${money(e.gex)} per 1%`),
    marker: { color: be.map((e) => (e.gex >= 0 ? c.pos : c.neg)), opacity: be.map((e) => (e.monthly ? 1 : 0.55)) }, hovertemplate: '%{customdata}<extra></extra>' }],
    baseLayout(c, { margin: { l: 56, r: 12, t: 12, b: 56 }, bargap: 0.3, xaxis: { color: c.ink3, tickangle: -40 }, yaxis: { color: c.ink3, gridcolor: c.rule, ticksuffix: 'B', zerolinecolor: c.ink3 } }), cfg);

  // implied volatility
  const iv = d.iv, ivK = iv.strikes.map((s) => s * k);
  if (S.iv === 'surface') {
    Plotly.react('pIV', [{ type: 'surface', x: iv.exps, y: ivK, z: iv.z, connectgaps: true, colorscale: [[0, c.acc], [0.5, c.panel], [1, c.flip]], showscale: false,
      hovertemplate: `Strike %{y:,.${dec()}f}<br>%{x}<br>IV %{z:.1f}%<extra></extra>` }],
      baseLayout(c, { margin: { l: 0, r: 0, t: 0, b: 0 }, scene: { bgcolor: c.panel, camera: { eye: { x: 1.6, y: -1.5, z: 0.8 } }, aspectratio: { x: 1.2, y: 1.4, z: 0.6 },
        xaxis: { title: { text: 'Expiry' }, color: c.ink3, gridcolor: c.rule, showbackground: false },
        yaxis: { title: { text: unit() }, color: c.ink3, gridcolor: c.rule, showbackground: false, tickformat: ',' },
        zaxis: { title: { text: 'IV %' }, color: c.ink3, gridcolor: c.rule, showbackground: false } } }), cfg);
  } else {
    const cols = [c.ink, c.acc, c.ink3];
    Plotly.react('pIV', iv.exps.slice(0, 3).map((e, j) => ({ type: 'scatter', mode: 'lines+markers', name: e, x: ivK, y: iv.z.map((r) => r[j]), connectgaps: true,
      line: { color: cols[j], width: j ? 1.5 : 2.2 }, marker: { size: 4 }, hovertemplate: `${e}<br>%{x:,.${dec()}f}: %{y:.1f}%<extra></extra>` })),
      baseLayout(c, { showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { color: c.ink2 } }, margin: { l: 50, r: 18, t: 30, b: 44 },
        xaxis: { color: c.ink3, gridcolor: c.rule, tickformat: ',', title: { text: unit(), font: { size: 11 } } }, yaxis: { color: c.ink3, gridcolor: c.rule, ticksuffix: '%' },
        shapes: [vLine(price(), c.ink, 'solid')] }), cfg);
  }
}
function hexA(col, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- controls ----------
function bind() {
  main.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { S.units = b.dataset.u; save(); render(); });
  main.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { S.view = b.dataset.view; save(); Plotly.purge('pMain'); render(); });
  main.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { S.mode = b.dataset.mode; save(); render(); });
  main.querySelectorAll('[data-greek]').forEach((b) => b.onclick = () => { S.greek = b.dataset.greek; save(); render(); });
  main.querySelectorAll('[data-iv]').forEach((b) => b.onclick = () => { S.iv = b.dataset.iv; save(); Plotly.purge('pIV'); render(); });
  const sel = document.getElementById('expSel');
  if (sel) sel.onchange = () => { S.exp = sel.value; render(); };
  copy('copyList', () => exportLevels().map(([n, v]) => `${v} ${n}`).join('\n'));
  copy('copyPine', pine);
}
function copy(id, text) {
  const b = document.getElementById(id), ok = document.getElementById(id + 'Ok');
  if (!b) return;
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text()); ok.textContent = 'Copied'; }
    catch (e) {
      const pre = id === 'copyPine' ? document.getElementById('pine') : null;
      if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ok.textContent = 'Selected: press Ctrl+C'; }
      else ok.textContent = 'Copy didn\'t work in this browser';
    }
    setTimeout(() => { ok.textContent = ''; }, 2500);
  };
}

document.getElementById('find').onsubmit = (e) => { e.preventDefault(); const i = document.getElementById('findIn'); go(i.value); i.value = ''; i.blur(); };
document.getElementById('themeBtn').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches || !matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('dm-theme', root.dataset.theme); } catch (e) {}
  if (S.d) { Plotly.purge('pMain'); Plotly.purge('pIV'); render(); }
};
addEventListener('popstate', () => { S.t = new URLSearchParams(location.search).get('t') || 'NQ'; nav(); load(S.t); });

// refresh every minute while the page is visible
function tick() {
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden && S.d) load(S.t, true); }, 60e3);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.d) load(S.t, true); });

S.t = (new URLSearchParams(location.search).get('t') || 'NQ').toUpperCase();
nav(); load(S.t); tick();
