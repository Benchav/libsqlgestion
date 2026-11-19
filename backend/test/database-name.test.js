const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveDatabaseName,
  isUuidLike,
} = require('../dist/application/shared/identifiers');

test('derives friendly database names from files and paths', () => {
  assert.equal(deriveDatabaseName(undefined, 'ventas.db', '/tmp/ventas.db'), 'ventas');
  assert.equal(deriveDatabaseName(undefined, undefined, '/tmp/clientes.sqlite'), 'clientes');
  assert.equal(deriveDatabaseName('ERP Central', 'ventas.db', '/tmp/ventas.db'), 'ERP Central');
});

test('refuses UUID-shaped file names as visible database names', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  assert.equal(isUuidLike(uuid), true);
  assert.equal(isUuidLike('ventas'), false);
  assert.equal(deriveDatabaseName(undefined, `${uuid}.db`, `/tmp/${uuid}.db`), 'imported-database');
  assert.equal(deriveDatabaseName(undefined, 'ventas.db', '/tmp/ventas.db'), 'ventas');
});
