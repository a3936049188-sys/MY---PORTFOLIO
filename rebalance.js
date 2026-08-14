(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RebalanceEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEYS = ['stock', 'crypto', 'cash'];
  const LABELS = { stock: '주식', crypto: '코인', cash: '현금' };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundWon(value) {
    return Math.round(Number(value) || 0);
  }

  function defaultThresholds(count) {
    const size = clamp(Math.round(Number(count) || 3), 1, 10);
    if (size === 1) return { buy: [40], sell: [60] };
    const buy = [];
    const sell = [];
    for (let index = 0; index < size; index += 1) {
      buy.push(Math.round((40 - (index * 25) / (size - 1)) * 10) / 10);
      sell.push(Math.round((60 + (index * 25) / (size - 1)) * 10) / 10);
    }
    return { buy, sell };
  }

  function equalWeights(count) {
    const size = clamp(Math.round(Number(count) || 3), 1, 10);
    const base = Math.floor((1000 / size)) / 10;
    const weights = Array(size).fill(base);
    weights[size - 1] = Math.round((100 - base * (size - 1)) * 10) / 10;
    return weights;
  }

  function defaultSettings() {
    const splitCount = 3;
    const thresholds = defaultThresholds(splitCount);
    return {
      targets: { stock: 70, crypto: 10, cash: 20 },
      splitCount,
      splitMode: 'custom',
      splitWeights: [50, 30, 20],
      buyThresholds: thresholds.buy,
      sellThresholds: thresholds.sell,
      extraCash: 0,
      maxExecutionRate: 100,
      sentimentEnabled: true,
    };
  }

  function normalizeSettings(input) {
    const defaults = defaultSettings();
    const source = input && typeof input === 'object' ? input : {};
    const splitCount = clamp(Math.round(Number(source.splitCount) || defaults.splitCount), 1, 10);
    const thresholds = defaultThresholds(splitCount);
    const targets = {};
    KEYS.forEach((key) => {
      const value = Number(source.targets && source.targets[key]);
      targets[key] = Number.isFinite(value) ? clamp(value, 0, 100) : defaults.targets[key];
    });
    const splitMode = source.splitMode === 'equal' ? 'equal' : 'custom';
    let splitWeights = Array.isArray(source.splitWeights) ? source.splitWeights.slice(0, splitCount).map(Number) : [];
    while (splitWeights.length < splitCount) splitWeights.push(0);
    if (splitMode === 'equal' || splitWeights.some((value) => !Number.isFinite(value) || value <= 0)) {
      splitWeights = equalWeights(splitCount);
    }
    const weightSum = splitWeights.reduce((sum, value) => sum + value, 0);
    if (Math.abs(weightSum - 100) > 0.01) splitWeights = equalWeights(splitCount);
    function normalizeThresholdList(value, fallback) {
      const list = Array.isArray(value) ? value.slice(0, splitCount).map(Number) : [];
      while (list.length < splitCount) list.push(fallback[list.length]);
      return list.map((item, index) => Number.isFinite(item) ? clamp(item, 0, 100) : fallback[index]);
    }
    return {
      targets,
      splitCount,
      splitMode,
      splitWeights,
      buyThresholds: normalizeThresholdList(source.buyThresholds, thresholds.buy),
      sellThresholds: normalizeThresholdList(source.sellThresholds, thresholds.sell),
      extraCash: Math.max(0, roundWon(source.extraCash)),
      maxExecutionRate: clamp(Number(source.maxExecutionRate) || 100, 1, 100),
      sentimentEnabled: source.sentimentEnabled !== false,
    };
  }

  function validateSettings(input) {
    const settings = normalizeSettings(input);
    const targetSum = KEYS.reduce((sum, key) => sum + settings.targets[key], 0);
    const weightSum = settings.splitWeights.reduce((sum, value) => sum + value, 0);
    const errors = [];
    if (Math.abs(targetSum - 100) > 0.01) errors.push('목표 비중 합계는 100%여야 합니다.');
    if (Math.abs(weightSum - 100) > 0.01) errors.push('분할 비중 합계는 100%여야 합니다.');
    return { valid: errors.length === 0, errors, settings, targetSum, weightSum };
  }

  function tolerance(target) {
    const value = Number(target) || 0;
    if (value <= 0) return 1;
    return Math.max(1, Math.min(5, value * 0.25));
  }

  function formulaRate(driftMultiple) {
    if (driftMultiple < 1) return 0;
    return clamp(((driftMultiple - 0.5) / 1.5) * 100, 0, 100);
  }

  function classifyAsset(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.cat === '주식') return 'stock';
    if (item.cat === '코인') return 'crypto';
    if (item.cat === '현금' || item.cat === '달러') return 'cash';
    return null;
  }

  function assetValue(item, exchangeRate) {
    const amount = Math.max(0, Number(item && item.amount) || 0);
    const isDollar = item && (item.cat === '달러' || (item.cat === '현금' && item.currency === 'USD'));
    return roundWon(isDollar ? amount * exchangeRate : amount);
  }

  function summarizeAssets(assets, exchangeRate) {
    const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 0;
    const balances = { stock: 0, crypto: 0, cash: 0 };
    const cashBreakdown = { krw: 0, usdKrw: 0, usd: 0, other: 0 };
    const missingPrices = [];
    (Array.isArray(assets) ? assets : []).forEach((item) => {
      const key = classifyAsset(item);
      if (!key) return;
      const value = assetValue(item, rate);
      if ((key === 'stock' || key === 'crypto') && Number(item.qty) > 0 && value <= 0) {
        missingPrices.push(item.name || '이름 없는 자산');
      }
      balances[key] += value;
      if (key === 'cash') {
        const isDollar = item.cat === '달러' || item.currency === 'USD';
        if (isDollar) {
          cashBreakdown.usd += Math.max(0, Number(item.amount) || 0);
          cashBreakdown.usdKrw += value;
        } else if (!item.currency || item.currency === 'KRW') {
          cashBreakdown.krw += value;
        } else {
          cashBreakdown.other += value;
        }
      }
    });
    return { balances, cashBreakdown, missingPrices };
  }

  function splitAmount(total, weights) {
    const amount = Math.max(0, roundWon(total));
    let used = 0;
    return weights.map((weight, index) => {
      const value = index === weights.length - 1 ? amount - used : Math.floor(amount * Number(weight) / 100);
      used += value;
      return value;
    });
  }

  function sentimentLabel(score) {
    if (!Number.isFinite(Number(score))) return '확인 불가';
    const value = Number(score);
    if (value <= 20) return '패닉';
    if (value <= 40) return '공포';
    if (value <= 60) return '중립';
    if (value <= 80) return '낙관';
    return '과열';
  }

  function calculatePlan(input) {
    const validation = validateSettings(input && input.settings);
    if (!validation.valid) return { valid: false, errors: validation.errors };
    const settings = validation.settings;
    const sourceBalances = input && input.balances ? input.balances : {};
    const balances = {
      stock: Math.max(0, roundWon(sourceBalances.stock)),
      crypto: Math.max(0, roundWon(sourceBalances.crypto)),
      cash: Math.max(0, roundWon(sourceBalances.cash)) + settings.extraCash,
    };
    const total = KEYS.reduce((sum, key) => sum + balances[key], 0);
    if (total <= 0) return { valid: false, errors: ['리밸런싱할 자산이 없습니다.'] };

    const rows = {};
    KEYS.forEach((key) => {
      const targetPct = settings.targets[key];
      const currentPct = balances[key] / total * 100;
      const targetAmount = total * targetPct / 100;
      const deltaAmount = targetAmount - balances[key];
      const driftPp = currentPct - targetPct;
      const band = tolerance(targetPct);
      const driftMultiple = Math.abs(driftPp) / band;
      const needScore = Math.min(100, driftMultiple * 50);
      const baseRate = formulaRate(driftMultiple);
      const appliedRate = Math.min(baseRate, settings.maxExecutionRate);
      rows[key] = {
        key,
        label: LABELS[key],
        balance: balances[key],
        targetPct,
        currentPct,
        targetAmount: roundWon(targetAmount),
        deltaAmount: roundWon(deltaAmount),
        driftPp,
        tolerancePp: band,
        driftMultiple,
        needScore,
        baseRate,
        appliedRate,
        triggered: driftMultiple >= 1,
        direction: deltaAmount > 0 ? 'buy' : deltaAmount < 0 ? 'sell' : 'hold',
        plannedAmount: driftMultiple >= 1 ? roundWon(Math.abs(deltaAmount) * appliedRate / 100) : 0,
      };
    });

    const riskKeys = ['stock', 'crypto'];
    const sells = riskKeys.filter((key) => rows[key].direction === 'sell' && rows[key].plannedAmount > 0)
      .map((key) => ({ key, label: LABELS[key], amount: rows[key].plannedAmount }));
    const sellTotal = sells.reduce((sum, item) => sum + item.amount, 0);
    const targetCash = rows.cash.targetAmount;
    const availableForBuys = Math.max(0, balances.cash + sellTotal - targetCash);
    const requestedBuys = riskKeys.filter((key) => rows[key].direction === 'buy' && rows[key].plannedAmount > 0)
      .map((key) => ({ key, label: LABELS[key], requested: rows[key].plannedAmount }));
    const requestedBuyTotal = requestedBuys.reduce((sum, item) => sum + item.requested, 0);
    let buyUsed = 0;
    const buys = requestedBuys.map((item, index) => {
      const amount = requestedBuyTotal <= availableForBuys
        ? item.requested
        : index === requestedBuys.length - 1
          ? Math.max(0, Math.min(item.requested, availableForBuys - buyUsed))
          : Math.floor(availableForBuys * item.requested / requestedBuyTotal);
      buyUsed += amount;
      return { key: item.key, label: item.label, amount, requested: item.requested };
    }).filter((item) => item.amount > 0);
    const buyTotal = buys.reduce((sum, item) => sum + item.amount, 0);

    const sentiment = input && input.sentiment ? input.sentiment : null;
    const score = sentiment && Number.isFinite(Number(sentiment.score)) ? Number(sentiment.score) : null;
    const calculatedAt = sentiment && sentiment.calculatedAt ? new Date(sentiment.calculatedAt) : null;
    const ageHours = calculatedAt && !Number.isNaN(calculatedAt.getTime()) ? (Date.now() - calculatedAt.getTime()) / 3600000 : null;
    const sentimentFresh = score !== null && ageHours !== null && ageHours <= 24;

    const actions = [];
    sells.forEach((item) => actions.push({ ...item, direction: 'sell', from: item.label, to: '현금' }));
    buys.forEach((item) => actions.push({ ...item, direction: 'buy', from: '현금', to: item.label }));
    actions.forEach((action) => {
      action.tranches = splitAmount(action.amount, settings.splitWeights).map((amount, index) => {
        let threshold = null;
        let ready = true;
        if (action.key === 'stock' && settings.sentimentEnabled) {
          threshold = action.direction === 'buy' ? settings.buyThresholds[index] : settings.sellThresholds[index];
          ready = sentimentFresh && (action.direction === 'buy' ? score <= threshold : score >= threshold);
        }
        return { index: index + 1, amount, weight: settings.splitWeights[index], threshold, ready };
      });
    });

    const projected = { ...balances };
    sells.forEach((item) => { projected[item.key] -= item.amount; projected.cash += item.amount; });
    buys.forEach((item) => { projected[item.key] += item.amount; projected.cash -= item.amount; });

    const maxNeedScore = Math.max(...KEYS.map((key) => rows[key].needScore));
    const urgency = maxNeedScore >= 100 ? '매우 높은 필요성' : maxNeedScore >= 75 ? '높은 필요성' : maxNeedScore >= 50 ? '조정 검토' : '목표 범위';
    const notes = [];
    if (requestedBuyTotal > availableForBuys) notes.push('목표 현금 비중을 지키기 위해 매수 금액이 제한되었습니다.');
    if (settings.sentimentEnabled && !sentimentFresh) notes.push('주식 심리 데이터가 없거나 24시간 이상 지나 분할 조건 판단에서 제외했습니다.');

    return {
      valid: true,
      settings,
      balances,
      total,
      rows,
      actions,
      projected,
      cashFlow: { sellTotal, buyTotal, availableForBuys, targetCash },
      sentiment: { score, label: sentimentLabel(score), calculatedAt: calculatedAt ? calculatedAt.toISOString() : null, ageHours, fresh: sentimentFresh },
      needScore: maxNeedScore,
      urgency,
      notes,
    };
  }

  return {
    KEYS,
    LABELS,
    defaultSettings,
    defaultThresholds,
    equalWeights,
    normalizeSettings,
    validateSettings,
    tolerance,
    formulaRate,
    summarizeAssets,
    splitAmount,
    sentimentLabel,
    calculatePlan,
  };
});
