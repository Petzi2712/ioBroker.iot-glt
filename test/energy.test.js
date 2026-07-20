'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { consumptionFromSeries, calculateEnergyReport } = require('../lib/energy');

test('counter consumption uses positive difference', () => {
  assert.equal(consumptionFromSeries([{ ts: 2, val: 125 }, { ts: 1, val: 100 }]), 25);
});

test('counter reset cannot produce negative consumption', () => {
  assert.equal(consumptionFromSeries([{ ts: 1, val: 100 }, { ts: 2, val: 3 }]), 0);
});

test('report calculates cost and CO2', () => {
  const result = calculateEnergyReport({ series: [{ ts: 1, val: 10 }, { ts: 2, val: 30 }], mode: 'counter', pricePerKwh: .4, co2Factor: .38 });
  assert.deepEqual(result, { consumptionKwh: 20, cost: 8, co2Kg: 7.6, samples: 2 });
});
