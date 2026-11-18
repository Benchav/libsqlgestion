const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sanitizeUploadFileName, resolveImportStagingRoot, cleanupStaleUploadDirs } = require('../dist/presentation/http/upload-utils');

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

  test('removes only stale upload directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-staging-cleanup-'));
    try {
      const stale = path.join(root, 'upload-stale');
      const fresh = path.join(root, 'upload-fresh');
      const keep = path.join(root, 'keep.txt');
      fs.mkdirSync(stale);
      fs.mkdirSync(fresh);
      fs.writeFileSync(keep, 'keep');

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

      await cleanupStaleUploadDirs(root, 24 * 60 * 60 * 1000);

      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(fresh), true);
      assert.equal(fs.existsSync(keep), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
