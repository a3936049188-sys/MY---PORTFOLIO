const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const sentiment = require('../market-sentiment-core');

async function getYahooHistory(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const response = await axios.get(url, {
    params: { interval: '1d', range: '3y' },
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const result = response.data.chart.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: Number(closes[index]),
    }))
    .filter((row) => Number.isFinite(row.close));
}

async function main() {
  const [spRows, vixRows] = await Promise.all([
    getYahooHistory('^GSPC'),
    getYahooHistory('^VIX'),
  ]);
  const rows = sentiment.buildRows(spRows, vixRows, 52).slice(-252);
  if (!rows.length) throw new Error('시장 심리 계산에 필요한 데이터가 부족합니다.');

  const payload = {
    generatedAt: new Date().toISOString(),
    latest: rows[rows.length - 1],
    series: rows,
    backtest: sentiment.buildBacktest(rows),
    model: {
      fearGreedWeight: 0.4,
      vixWeight: 0.3,
      spTrendWeight: 0.3,
      vixRange: [10, 80],
    },
    source: 'Yahoo Finance chart data, refreshed by GitHub Actions',
  };

  const outputPath = path.join(__dirname, '..', 'market-sentiment-data.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`market sentiment data updated: ${payload.latest.date}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
