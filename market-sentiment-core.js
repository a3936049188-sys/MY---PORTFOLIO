(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarketSentimentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REGIMES = [
    { max: 20, label: 'Panic' },
    { max: 40, label: 'Fear' },
    { max: 60, label: 'Neutral' },
    { max: 80, label: 'Optimistic' },
    { max: 100, label: 'Euphoria' },
  ];

  function clamp(value, min = 0, max = 100) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function classifyRegime(score) {
    const clipped = clamp(score);
    return REGIMES.find((regime) => clipped <= regime.max)?.label || 'Euphoria';
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

  function scoreRow(row, fearGreed) {
    const score = clamp(
      0.4 * clamp(fearGreed) + 0.3 * Number(row.vixScore) + 0.3 * Number(row.spTrendScore),
    );
    return {
      ...row,
      fearGreed: clamp(fearGreed),
      fearGreedScore: clamp(fearGreed),
      marketSentiment: score,
      regime: classifyRegime(score),
    };
  }

  function buildRows(spRows, vixRows, fearGreed = 52) {
    const vixByDate = new Map(vixRows.map((row) => [row.date, Number(row.close)]));
    const closes = spRows.map((row) => Number(row.close));
    const rows = [];

    spRows.forEach((row, index) => {
      const close = Number(row.close);
      const vix = vixByDate.get(row.date);
      if (!Number.isFinite(close) || !Number.isFinite(vix)) return;

      const sma50 = movingAverage(closes, index, 50);
      const sma200 = movingAverage(closes, index, 200);
      const high52w = rollingHigh(closes, index, 252);
      const trend = spTrendScore(close, sma50, sma200, high52w);
      if (!trend) return;

      rows.push(scoreRow({
        date: row.date,
        close,
        vix,
        vixScore: vixScore(vix),
        sma50,
        sma200,
        high52w,
        trend50Score: trend.trend50,
        trend200Score: trend.trend200,
        high52wScore: trend.high52w,
        spTrendScore: trend.score,
      }, fearGreed));
    });

    return rows;
  }

  function forwardReturn(rows, startIndex, horizon) {
    const current = rows[startIndex];
    const future = rows[startIndex + horizon];
    if (!current || !future || !Number(current.close)) return null;
    return Number(future.close) / Number(current.close) - 1;
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

  function applyFearGreed(data, fearGreed) {
    const series = (data.series || []).map((row) => scoreRow(row, fearGreed));
    const latestBase = data.latest || series[series.length - 1];
    if (!latestBase) throw new Error('시장 심리 기준 데이터가 없습니다.');
    const latest = scoreRow(latestBase, fearGreed);
    return {
      ...data,
      latest,
      series,
      backtest: buildBacktest(series),
    };
  }

  return {
    clamp,
    classifyRegime,
    vixScore,
    compositeScore,
    buildRows,
    buildBacktest,
    applyFearGreed,
  };
});
