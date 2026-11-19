const test = require('node:test');
const assert = require('node:assert/strict');

const { runtimeIdentityMatches } = require('../dist/application/databases/runtime-health-guard');

test.describe('runtime health identity guard', () => {
  const expected = { containerId: 'runtime-1', authKeyPem: 'KEY-1' };

  test('accepts the runtime that was actually checked', () => {
    assert.equal(
      runtimeIdentityMatches({ containerId: 'runtime-1', authKeyPem: 'KEY-1' }, expected),
      true,
    );
  });

  test('rejects a runtime replaced while health was being checked', () => {
    assert.equal(
      runtimeIdentityMatches({ containerId: 'runtime-2', authKeyPem: 'KEY-2' }, expected),
      false,
    );
  });

  test('rejects rotated signing keys on the same container id', () => {
    assert.equal(
      runtimeIdentityMatches({ containerId: 'runtime-1', authKeyPem: 'KEY-2' }, expected),
      false,
    );
  });

  test('rejects missing metadata', () => {
    assert.equal(runtimeIdentityMatches(null, expected), false);
    assert.equal(runtimeIdentityMatches(undefined, expected), false);
    assert.equal(runtimeIdentityMatches({}, expected), false);
  });
});
