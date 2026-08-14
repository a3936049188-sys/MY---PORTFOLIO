const assert = require('node:assert/strict');
const engine = require('./rebalance');

function nearly(actual, expected, epsilon = 0.01) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

assert.equal(engine.tolerance(70), 5);
assert.equal(engine.tolerance(10), 2.5);
assert.equal(engine.tolerance(0), 1);
nearly(engine.formulaRate(1), 33.3333333333);
assert.equal(engine.formulaRate(2), 100);

const summary = engine.summarizeAssets([
  { cat: '주식', name: 'VOO', qty: 1, amount: 70000000 },
  { cat: '코인', name: 'BTC', qty: 1, amount: 10000000 },
  { cat: '현금', name: '원화', amount: 10000000, currency: 'KRW' },
  { cat: '현금', name: '달러', amount: 10000, currency: 'USD' },
  { cat: '적금', name: '적금', amount: 50000000 },
], 1000);
assert.deepEqual(summary.balances, { stock: 70000000, crypto: 10000000, cash: 20000000 });

const balanced = engine.calculatePlan({
  balances: summary.balances,
  settings: engine.defaultSettings(),
  sentiment: { score: 30, calculatedAt: new Date().toISOString() },
});
assert.equal(balanced.valid, true);
assert.equal(balanced.actions.length, 0);

const drifted = engine.calculatePlan({
  balances: { stock: 60000000, crypto: 15000000, cash: 25000000 },
  settings: engine.defaultSettings(),
  sentiment: { score: 30, calculatedAt: new Date().toISOString() },
});
assert.equal(drifted.valid, true);
assert.equal(drifted.rows.stock.direction, 'buy');
assert.equal(drifted.rows.crypto.direction, 'sell');
assert.equal(drifted.rows.stock.triggered, true);
assert.equal(drifted.rows.crypto.driftMultiple, 2);
assert.ok(drifted.actions.some((action) => action.from === '코인' && action.to === '현금'));
assert.ok(drifted.actions.some((action) => action.from === '현금' && action.to === '주식'));

const withContribution = engine.calculatePlan({
  balances: { stock: 60000000, crypto: 10000000, cash: 20000000 },
  settings: { ...engine.defaultSettings(), extraCash: 10000000 },
  sentiment: { score: 30, calculatedAt: new Date().toISOString() },
});
assert.equal(withContribution.total, 100000000);
assert.equal(withContribution.balances.cash, 30000000);
assert.ok(withContribution.actions.some((action) => action.to === '주식'));

const customSplit = engine.splitAmount(100, [50, 30, 20]);
assert.deepEqual(customSplit, [50, 30, 20]);
assert.equal(customSplit.reduce((sum, value) => sum + value, 0), 100);

const invalid = engine.calculatePlan({
  balances: summary.balances,
  settings: { ...engine.defaultSettings(), targets: { stock: 60, crypto: 10, cash: 20 } },
});
assert.equal(invalid.valid, false);

const customTarget = engine.calculatePlan({
  balances: { stock: 50000000, crypto: 10000000, cash: 40000000 },
  settings: { ...engine.defaultSettings(), targets: { stock: 60, crypto: 10, cash: 30 } },
  sentiment: { score: 90, calculatedAt: new Date().toISOString() },
});
assert.equal(customTarget.valid, true);
assert.equal(customTarget.rows.cash.currentPct, 40);
assert.equal(customTarget.rows.stock.direction, 'buy');
assert.ok(customTarget.cashFlow.buyTotal <= customTarget.cashFlow.availableForBuys);

const staleSentiment = engine.calculatePlan({
  balances: { stock: 60000000, crypto: 10000000, cash: 30000000 },
  settings: engine.defaultSettings(),
  sentiment: { score: 10, calculatedAt: '2020-01-01T00:00:00.000Z' },
});
const staleStockAction = staleSentiment.actions.find((action) => action.key === 'stock');
assert.equal(staleSentiment.sentiment.fresh, false);
assert.ok(staleStockAction.tranches.every((tranche) => tranche.ready === false));

console.log('rebalance tests passed');
