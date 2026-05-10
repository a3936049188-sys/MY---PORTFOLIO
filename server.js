const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// 티커 → CoinGecko ID 매핑 (코인)
const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', SOL: 'solana',
  BNB: 'binancecoin', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', TRX: 'tron',
  LTC: 'litecoin', ATOM: 'cosmos', UNI: 'uniswap', NEAR: 'near',
};

// 환율 조회 (USD → KRW)
async function getExchangeRate() {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    return res.data.rates?.KRW || 1380;
  } catch {
    return 1380;
  }
}

// 미국 주식 가격 조회 (Yahoo Finance)
async function getStockPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const res = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const price = res.data.chart.result?.[0]?.meta?.regularMarketPrice;
    return price || null;
  } catch {
    return null;
  }
}

// 코인 가격 조회 (CoinGecko)
async function getCoinPrices(tickers) {
  const ids = tickers.map(t => COIN_IDS[t.toUpperCase()]).filter(Boolean);
  if (!ids.length) return {};
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: ids.join(','), vs_currencies: 'krw' },
      timeout: 5000
    });
    const result = {};
    tickers.forEach(t => {
      const id = COIN_IDS[t.toUpperCase()];
      if (id && res.data[id]) result[t.toUpperCase()] = res.data[id].krw;
    });
    return result;
  } catch {
    return {};
  }
}

// 메인 동기화 엔드포인트
app.get('/sync', async (req, res) => {
  // 쿼리로 티커 받기: /sync?stocks=VOO,AAPL&coins=BTC,ETH
  const stockTickers = req.query.stocks ? req.query.stocks.split(',').map(s => s.trim().toUpperCase()) : [];
  const coinTickers  = req.query.coins  ? req.query.coins.split(',').map(s => s.trim().toUpperCase()) : [];

  const [rate, coinPrices] = await Promise.all([
    getExchangeRate(),
    getCoinPrices(coinTickers)
  ]);

  const result = { EXCHANGE_RATE: rate };

  // 주식: USD 가격 그대로 반환 (앱에서 환율 환산)
  for (const ticker of stockTickers) {
    const usdPrice = await getStockPrice(ticker);
    if (usdPrice !== null) result[ticker] = usdPrice;
  }

  // 코인: KRW 가격
  Object.assign(result, coinPrices);

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
  console.log(`📊 동기화 URL: http://localhost:${PORT}/sync?stocks=VOO,AAPL&coins=BTC,ETH`);
});
