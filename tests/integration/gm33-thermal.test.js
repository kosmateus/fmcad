'use strict';

// Live integration tests for GM-33 (lumped thermal contact-budget). This family
// is a LOCAL analytic method: it runs without --doc, produces numeric SI values,
// never touches Fusion, and never claims a CFD/FEA result.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { local } = require('./helper');

const near = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tol, `${actual} != ${expected}`);

function base() {
  return {
    schemaVersion: 1,
    identity: { model: 'thermal-fixture', revision: '1' },
    frame: 'contact-normal',
    assumptions: ['Steady series heat flow; nominal constant material properties; all loads at source.'],
    heatLoads: [{ id: 'chip', power: '4 W' }, { id: 'driver', power: '1 W' }],
    ambient: '25 degC',
    maximumTemperature: '50 degC',
    contacts: [{
      id: 'pad', model: 'pad', contactPresent: true, area: '100 mm2', thickness: '1 mm',
      conductivity: '2 W/(m*K)', compression: { nominal: '20 %', minimum: '10 %', maximum: '30 %' },
      allowableCompression: { minimum: '10 %', maximum: '30 %' }, interfaceResistance: '0 K/W',
    }],
    ambientPath: { model: 'resistance', resistance: '.5 K/W' },
  };
}

test('gm33: G33-01 contact-budget evaluates the analytic pad stack and temperatures', () => {
  const out = local(['thermal', 'contact-budget', '--data', JSON.stringify(base())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.operation, 'thermal.contact-budget');
  near(out.result.contactResistance.value, 4);
  near(out.result.totalResistance.value, 4.5);
  near(out.result.sourceTemperature.value, 320.65);
  near(out.result.maximumSourceTemperature.value, 323.15);
  near(out.result.minimumSourceTemperature.value, 318.15);
  near(out.result.heatRejected.value, 5);
  near(out.result.contacts[0].coldTemperature.value, 300.65);
});

test('gm33: G33-02 contact-budget reports sensitivity and flags missing data as unknown', () => {
  const out = local(['thermal', 'contact-budget', '--data', JSON.stringify(base())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.contacts[0].sensitivity.resistancePerCompression.value, -5);
  assert.equal(out.result.sensitivity.temperaturePerPower.unit, 'K/W');

  const missing = base();
  delete missing.ambientPath;
  const unknown = local(['thermal', 'contact-budget', '--data', JSON.stringify(missing)]);
  assert.equal(unknown.status, 'unknown', JSON.stringify(unknown));
  assert.equal(unknown.result.sourceTemperature, null);
  near(unknown.result.contactResistance.value, 4);
});

test('gm33: G33-03 missing contact or ambient resistance never becomes a zero resistance', () => {
  const noContact = base();
  noContact.contacts[0].contactPresent = false;
  const failed = local(['thermal', 'contact-budget', '--data', JSON.stringify(noContact)]);
  assert.equal(failed.status, 'fail', JSON.stringify(failed));
  assert.equal(failed.result.sourceTemperature, null);

  const noAmbient = base();
  delete noAmbient.ambientPath;
  const unknown = local(['thermal', 'contact-budget', '--data', JSON.stringify(noAmbient)]);
  assert.equal(unknown.status, 'unknown', JSON.stringify(unknown));
  assert.equal(unknown.result.ambientResistance, null);
});

test('gm33: G33-04 the method is a local lumped model and never claims CFD/FEA', () => {
  const out = local(['thermal', 'contact-budget', '--data', JSON.stringify(base())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.method, 'local-analytic-v1');
  assert.ok(out.limitations.some((l) => /No CFD\/FEA/.test(l)));
  assert.equal(out.documentIdentity, null);
});
