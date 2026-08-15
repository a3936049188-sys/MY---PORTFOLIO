const assert = require('node:assert/strict');
const sentiment = require('./market-sentiment-core');

assert.equal(sentiment.classifyRegime(20), 'Panic');
assert.equal(sentiment.classifyRegime(52), 'Neutral');
assert.equal(sentiment.vixScore(10), 100);
assert.equal(sentiment.vixScore(80), 0);
assert.equal(sentiment.compositeScore(50, 45, 50), 50);

const spRows = [];
const vixRows = [];
for (let index = 0; index < 320; index += 1) {
  const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
  spRows.push({ date, close: 4000 + index * 2 });
  vixRows.push({ date, close: 20 });
}

const rows = sentiment.buildRows(spRows, vixRows, 52);
assert.ok(rows.length > 60);
assert.equal(rows.at(-1).fearGreedScore, 52);
assert.ok(Number.isFinite(rows.at(-1).spTrendScore));

const adjusted = sentiment.applyFearGreed({ latest: rows.at(-1), series: rows }, 10);
assert.equal(adjusted.latest.fearGreedScore, 10);
assert.ok(adjusted.latest.marketSentiment < rows.at(-1).marketSentiment);
assert.equal(adjusted.backtest.length, 9);

const snapshot = require('./market-sentiment-data.json');
const snapshotAdjusted = sentiment.applyFearGreed(snapshot, 25);
assert.equal(snapshotAdjusted.series.length, 252);
assert.equal(snapshotAdjusted.backtest.length, 9);
assert.equal(snapshotAdjusted.latest.fearGreedScore, 25);

console.log('market sentiment core tests passed');
