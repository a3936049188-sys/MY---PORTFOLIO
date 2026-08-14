const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const SHEET_SYNC_URL_FILE = path.join(__dirname, '.sheet-sync-url');
const DEFAULT_SHEET_SYNC_URL = (() => {
  try {
    return fs.readFileSync(SHEET_SYNC_URL_FILE, 'utf8').trim();
  } catch {
    return '';
  }
})();

app.use(cors());
app.use(express.static(path.join(__dirname)));

const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', SOL: 'solana',
  BNB: 'binancecoin', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', TRX: 'tron',
  LTC: 'litecoin', ATOM: 'cosmos', UNI: 'uniswap', NEAR: 'near',
};

const SENTIMENT_REGIMES = [
  { max: 20, label: 'Panic' },
  { max: 40, label: 'Fear' },
  { max: 60, label: 'Neutral' },
  { max: 80, label: 'Optimistic' },
  { max: 100, label: 'Euphoria' },
];

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function classifyRegime(score) {
  const clipped = clamp(score);
  return SENTIMENT_REGIMES.find((regime) => clipped <= regime.max)?.label || 'Euphoria';
}

function vixScore(vix, floor = 10, ceiling = 80) {
  return clamp(((ceiling - vix) / (ceiling - floor)) * 100);
}

function movingAverage(closes, index, window) {
  if (index + 1 < window) return null;
  return mean(closes.slice(index + 1 - window, index + 1));
}

function rollingHigh(closes, index, window) {
  if (index + 1 < window) return null;
  return Math.max(...closes.slice(index + 1 - window, index + 1));
}

function priceVsAverageScore(price, average, fullScoreBand) {
  if (!price || !average) return null;
  const distance = price / average - 1;
  return clamp(50 + (distance / fullScoreBand) * 50);
}

function spTrendScore(price, sma50, sma200, high52w) {
  const trend50 = priceVsAverageScore(price, sma50, 0.10);
  const trend200 = priceVsAverageScore(price, sma200, 0.20);
  const highScore = high52w ? clamp(100 + ((price / high52w - 1) / 0.20) * 100) : null;
  if ([trend50, trend200, highScore].some((value) => value === null)) return null;
  return {
    trend50,
    trend200,
    high52w: highScore,
    score: clamp(0.4 * trend50 + 0.4 * trend200 + 0.2 * highScore),
  };
}

function compositeScore(fearGreed, vix, trendScore) {
  return clamp(0.4 * clamp(fearGreed) + 0.3 * vixScore(vix) + 0.3 * trendScore);
}

function forwardReturn(rows, startIndex, horizon) {
  const future = rows[startIndex + horizon];
  const current = rows[startIndex];
  if (!future || !current || !current.close) return null;
  return future.close / current.close - 1;
}

function summarizeReturns(rows, mask, horizon) {
  const returns = [];
  rows.forEach((row, index) => {
    if (!mask(row)) return;
    const value = forwardReturn(rows, index, horizon);
    if (Number.isFinite(value)) returns.push(value);
  });

  if (!returns.length) {
    return { observations: 0, averageReturn: null, medianReturn: null, winRate: null };
  }

  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    observations: returns.length,
    averageReturn: mean(returns),
    medianReturn: median,
    winRate: returns.filter((value) => value > 0).length / returns.length,
  };
}

async function getExchangeRate() {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    return res.data.rates?.KRW || 1380;
  } catch {
    return 1380;
  }
}

async function getStockPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await axios.get(url, {
      timeout: 7000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return res.data.chart.result?.[0]?.meta?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

async function getCoinPrices(tickers) {
  const ids = tickers.map((ticker) => COIN_IDS[ticker.toUpperCase()]).filter(Boolean);
  if (!ids.length) return {};

  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: ids.join(','), vs_currencies: 'krw' },
      timeout: 7000,
    });
    const result = {};
    tickers.forEach((ticker) => {
      const id = COIN_IDS[ticker.toUpperCase()];
      if (id && res.data[id]) result[ticker.toUpperCase()] = res.data[id].krw;
    });
    return result;
  } catch {
    return {};
  }
}

async function getYahooHistory(symbol, range = '20y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const result = res.data.chart.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = quote.close || [];

  return timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: Number(closes[index]),
    }))
    .filter((row) => Number.isFinite(row.close));
}

function parseAppsScriptUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const isAppsScriptHost = url.hostname === 'script.google.com';
  const isDeploymentPath = /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname);
  if (url.protocol !== 'https:' || !isAppsScriptHost || !isDeploymentPath) return null;
  return url;
}

function buildMarketSentiment(spRows, vixRows, fearGreed) {
  const vixByDate = new Map(vixRows.map((row) => [row.date, row.close]));
  const closes = spRows.map((row) => row.close);
  const rows = [];

  spRows.forEach((row, index) => {
    const vix = vixByDate.get(row.date);
    if (!Number.isFinite(vix)) return;

    const sma50 = movingAverage(closes, index, 50);
    const sma200 = movingAverage(closes, index, 200);
    const high52w = rollingHigh(closes, index, 252);
    const trend = spTrendScore(row.close, sma50, sma200, high52w);
    if (!trend) return;

    const score = compositeScore(fearGreed, vix, trend.score);
    rows.push({
      date: row.date,
      close: row.close,
      fearGreed: clamp(fearGreed),
      vix,
      fearGreedScore: clamp(fearGreed),
      vixScore: vixScore(vix),
      sma50,
      sma200,
      high52w,
      trend50Score: trend.trend50,
      trend200Score: trend.trend200,
      high52wScore: trend.high52w,
      spTrendScore: trend.score,
      marketSentiment: score,
      regime: classifyRegime(score),
    });
  });

  return rows;
}

function buildBacktest(rows) {
  const horizons = [
    { label: '1W', days: 5 },
    { label: '1M', days: 21 },
    { label: '3M', days: 63 },
  ];
  const groups = [
    { label: 'Panic < 20', mask: (row) => row.marketSentiment < 20 },
    { label: 'Euphoria > 80', mask: (row) => row.marketSentiment > 80 },
    { label: 'All Days', mask: () => true },
  ];

  return groups.flatMap((group) => horizons.map((horizon) => ({
    group: group.label,
    horizon: horizon.label,
    ...summarizeReturns(rows, group.mask, horizon.days),
  })));
}

app.get('/sync', async (req, res) => {
  const stockTickers = req.query.stocks ? req.query.stocks.split(',').map((s) => s.trim().toUpperCase()) : [];
  const coinTickers = req.query.coins ? req.query.coins.split(',').map((s) => s.trim().toUpperCase()) : [];

  const [rate, coinPrices] = await Promise.all([
    getExchangeRate(),
    getCoinPrices(coinTickers),
  ]);

  const result = { EXCHANGE_RATE: rate };
  for (const ticker of stockTickers) {
    const usdPrice = await getStockPrice(ticker);
    if (usdPrice !== null) result[ticker] = usdPrice;
  }
  Object.assign(result, coinPrices);
  res.json(result);
});

app.get('/sheet-sync', async (req, res) => {
  const url = parseAppsScriptUrl(String(req.query.url || DEFAULT_SHEET_SYNC_URL));
  if (!url) {
    res.status(400).json({
      error: 'Apps Script 배포 URL이 올바르지 않습니다. /exec로 끝나는 웹 앱 URL을 입력해주세요.',
    });
    return;
  }

  console.log('[sheet-sync] request started', { host: url.hostname });
  try {
    const response = await axios.get(url.toString(), {
      timeout: 30000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'portfolio-sheet-sync/1.0' },
    });

    if (!response.data || typeof response.data !== 'object') {
      throw new Error('Apps Script가 JSON 객체를 반환하지 않았습니다.');
    }

    console.log('[sheet-sync] request completed');
    res.json(response.data);
  } catch (error) {
    console.error('[sheet-sync] request failed', {
      message: error.message,
      status: error.response?.status,
    });
    res.status(502).json({
      error: '구글 시트 데이터를 불러오지 못했습니다.',
      detail: error.response?.status === 401 || error.response?.status === 403
        ? 'Apps Script 배포 권한을 모든 사용자로 설정했는지 확인해주세요.'
        : 'Apps Script 실행 및 배포 상태를 확인해주세요.',
    });
  }
});

app.get('/market-sentiment', async (req, res) => {
  const fearGreed = Number(req.query.fearGreed ?? 52);
  if (!Number.isFinite(fearGreed) || fearGreed < 0 || fearGreed > 100) {
    res.status(400).json({ error: 'fearGreed must be a number between 0 and 100.' });
    return;
  }

  try {
    const [spRows, vixRows] = await Promise.all([
      getYahooHistory('^GSPC'),
      getYahooHistory('^VIX'),
    ]);
    const rows = buildMarketSentiment(spRows, vixRows, fearGreed);
    if (!rows.length) {
      res.status(502).json({ error: 'Not enough Yahoo Finance data to calculate sentiment.' });
      return;
    }

    const latest = rows[rows.length - 1];
    res.json({
      latest,
      series: rows.slice(-252),
      backtest: buildBacktest(rows),
      model: {
        fearGreedWeight: 0.4,
        vixWeight: 0.3,
        spTrendWeight: 0.3,
        vixRange: [10, 80],
      },
      source: 'Yahoo Finance via yfinance-style chart endpoint',
    });
  } catch (error) {
    res.status(502).json({ error: 'Market sentiment data fetch failed.', detail: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Sync API: http://localhost:${PORT}/sync?stocks=VOO,AAPL&coins=BTC,ETH`);
  console.log(`Sentiment API: http://localhost:${PORT}/market-sentiment?fearGreed=52`);
});
