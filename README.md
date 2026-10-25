# Dealer Map

Dealer gamma levels for NQ, ES, SPX, NDX, SPY, QQQ, IWM and any optionable ticker: gamma flip, call and put walls, max pain, expected move, gamma by strike and expiry (heatmap and 3D), delta, vanna and charm exposure, implied volatility surface, unusual options activity, and a TradingView export.

- `gex.js`: the one server function (`/api/gex?t=NQ`). Reads CBOE's free delayed options data, does the maths, caches for a minute.
- `index.html`, `app.js`, `app.css`: the page. No build step.
- Deployed on Vercel from this repo.

For education, not financial advice.
