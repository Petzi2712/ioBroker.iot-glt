'use strict';

function normalizeSeries(values) {
  return (Array.isArray(values) ? values : [])
    .filter(item => Number.isFinite(Number(item.val)) && Number.isFinite(Number(item.ts)))
    .map(item => ({ ts: Number(item.ts), val: Number(item.val) }))
    .sort((a, b) => a.ts - b.ts);
}

function consumptionFromSeries(values, mode = 'counter') {
  const series = normalizeSeries(values);
  if (!series.length) return 0;
  if (mode === 'sum') return series.reduce((sum, item) => sum + item.val, 0);
  if (mode === 'average') return series.reduce((sum, item) => sum + item.val, 0) / series.length;
  return Math.max(0, series.at(-1).val - series[0].val);
}

function calculateEnergyReport({ series, mode, pricePerKwh, co2Factor }) {
  const consumptionKwh = consumptionFromSeries(series, mode);
  return {
    consumptionKwh,
    cost: consumptionKwh * Number(pricePerKwh || 0),
    co2Kg: consumptionKwh * Number(co2Factor || 0),
    samples: normalizeSeries(series).length
  };
}

module.exports = { normalizeSeries, consumptionFromSeries, calculateEnergyReport };
