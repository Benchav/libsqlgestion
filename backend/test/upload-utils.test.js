const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { sanitizeUploadFileName, resolveImportStagingRoot } = require('../dist/presentation/http/upload-utils');

test.describe('Import upload utilities', () => {
  test.afterEach(() => {
    delete process.env.IMPORT_STAGING_DIR;
    delete process.env.DATABASE_FILE;
  });

  test('strips directory traversal from uploaded file names', () => {
    assert.equal(sanitizeUploadFileName('../../etc/passwd.db'), 'passwd.db');
    assert.equal(sanitizeUploadFileName('C:\\Users\\erp\\backup.db'), 'backup.db');
    assert.equal(sanitizeUploadFileName('...'), 'database.db');
    assert.equal(sanitizeUploadFileName(''), 'database.db');
    assert.equal(sanitizeUploadFileName('mi base.db'), 'mi_base.db');
  });

  test('uses IMPORT_STAGING_DIR when configured', () => {
    process.env.IMPORT_STAGING_DIR = path.join('tmp', 'custom-imports');
    assert.equal(resolveImportStagingRoot(), path.join('tmp', 'custom-imports'));
  });

  test('places staging next to the control database by default', () => {
    process.env.DATABASE_FILE = path.join('app', 'data', 'control.db');
    assert.equal(resolveImportStagingRoot(), path.join('app', 'data', 'tmp'));
  });
});
