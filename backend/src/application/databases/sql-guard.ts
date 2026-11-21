export type SqlOperation = 'read' | 'write' | 'neutral' | 'unknown';

export type SqlClassification = {
  operation: SqlOperation;
  returnsRows: boolean;
  keyword: string;
};

type SqlToken = {
  value: string;
  kind: 'word' | 'punct';
  depth: number;
};

const MAIN_STATEMENT_KEYWORDS = new Set([
  'SELECT',
  'VALUES',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
]);

// PRAGMAs that mutate the database/connection even without an `= value`.
const ALWAYS_MUTATING_PRAGMAS = new Set([
  'wal_checkpoint',
  'optimize',
  'incremental_vacuum',
  'shrink_memory',
  'reset_connection',
]);

// PRAGMAs that are safe to use as read-only introspection. The argument form
// is only allowed for this list (e.g. PRAGMA table_info("users")).
const INTROSPECTION_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'integrity_check',
  'quick_check',
  'freelist_count',
  'page_count',
]);

// PRAGMAs that can be read without an argument but mutate the connection or
// database when an assignment/argument is supplied (e.g. journal_mode=WAL).
const CONFIGURABLE_PRAGMAS = new Set([
  'encoding',
  'schema_version',
  'user_version',
  'journal_mode',
  'synchronous',
  'cache_size',
  'temp_store',
  'mmap_size',
  'busy_timeout',
  'foreign_keys',
  'query_only',
  'locking_mode',
  'secure_delete',
  'auto_vacuum',
  'application_id',
  'max_page_count',
  'page_size',
  'journal_size_limit',
  'cache_spill',
  'cell_size_check',
  'checkpoint_fullfsync',
  'fullfsync',
  'reverse_unordered_selects',
  'trusted_schema',
  'recursive_triggers',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'read_uncommitted',
  'threads',
]);

function isWordCharacter(char: string) {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Minimal SQLite tokenizer for policy decisions.
 *
 * It intentionally discards string literals, quoted identifiers and comments
 * so a keyword inside a string can never influence the classifier. It also
 * tracks parentheses so only the main statement (not a CTE body) is inspected.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line-comment' | 'block-comment' = 'normal';
  let depth = 0;
  let word = '';

  const flushWord = () => {
    if (!word) return;
    tokens.push({ value: word, kind: 'word', depth });
    word = '';
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }

    if (state === 'single') {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }

    if (state === 'double') {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'backtick') {
      if (char === '`') state = 'normal';
      continue;
    }

    if (state === 'bracket') {
      if (char === ']') state = 'normal';
      continue;
    }

    if (char === '-' && next === '-') {
      flushWord();
      index += 1;
      state = 'line-comment';
      continue;
    }

    if (char === '/' && next === '*') {
      flushWord();
      index += 1;
      state = 'block-comment';
      continue;
    }

    if (char === "'") {
      flushWord();
      state = 'single';
      continue;
    }

    if (char === '"') {
      flushWord();
      state = 'double';
      continue;
    }

    if (char === '`') {
      flushWord();
      state = 'backtick';
      continue;
    }

    if (char === '[') {
      flushWord();
      state = 'bracket';
      continue;
    }

    if (isWordCharacter(char)) {
      word += char;
      continue;
    }

    flushWord();

    if (char === '(') {
      tokens.push({ value: char, kind: 'punct', depth });
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ value: char, kind: 'punct', depth });
      continue;
    }

    if (!/\s/.test(char)) {
      tokens.push({ value: char, kind: 'punct', depth });
    }
  }

  flushWord();
  return tokens;
}

function topLevelWords(tokens: SqlToken[]) {
  return tokens
    .filter((token) => token.kind === 'word' && token.depth === 0)
    .map((token) => token.value.toUpperCase());
}

function hasKeyword(tokens: SqlToken[], keyword: string) {
  return tokens.some((token) => token.kind === 'word' && token.value.toUpperCase() === keyword);
}

function classifyPragma(tokens: SqlToken[]): SqlClassification {
  const afterPragma = tokens.filter((token) => token.kind === 'word' || token.value === '.' || token.value === '=');
  const firstWordIndex = afterPragma.findIndex((token) => token.kind === 'word' && token.value.toUpperCase() === 'PRAGMA');
  const nameTokens = firstWordIndex >= 0 ? afterPragma.slice(firstWordIndex + 1) : afterPragma;
  const nameIndex = nameTokens.findIndex((token) => token.kind === 'word');
  if (nameIndex < 0) {
    return { operation: 'unknown', returnsRows: true, keyword: 'PRAGMA' };
  }

  let name = nameTokens[nameIndex].value.toLowerCase();
  // Support PRAGMA main.table_info(...).
  if (nameTokens[nameIndex + 1]?.value === '.') {
    const qualified = nameTokens.slice(nameIndex + 2).find((token) => token.kind === 'word');
    if (qualified) name = qualified.value.toLowerCase();
  }

  const hasAssignment = tokens.some((token) => token.value === '=');
  const hasArguments = tokens.some((token) => token.value === '(');

  if (hasAssignment) {
    return { operation: 'write', returnsRows: false, keyword: 'PRAGMA' };
  }

  if (ALWAYS_MUTATING_PRAGMAS.has(name)) {
    return { operation: 'write', returnsRows: false, keyword: 'PRAGMA' };
  }

  if (hasArguments) {
    // Only the explicit introspection list may take arguments as a read.
    // Everything else (journal_mode(WAL), optimize(...), etc.) is a write.
    return INTROSPECTION_PRAGMAS.has(name)
      ? { operation: 'read', returnsRows: true, keyword: 'PRAGMA' }
      : { operation: 'write', returnsRows: false, keyword: 'PRAGMA' };
  }

  if (INTROSPECTION_PRAGMAS.has(name) || CONFIGURABLE_PRAGMAS.has(name)) {
    return { operation: 'read', returnsRows: true, keyword: 'PRAGMA' };
  }

  // Unknown PRAGMA without an explicit assignment. Refuse to guess when a
  // protection flag is active instead of accidentally allowing a mutation.
  return { operation: 'unknown', returnsRows: true, keyword: 'PRAGMA' };
}

/**
 * Returns the effective top-level statement keyword. For `WITH` statements it
 * skips the CTE bodies and returns the main `SELECT`/`INSERT`/`UPDATE`/`DELETE`.
 * This keeps analytics read/write classification aligned with the protection
 * classifier.
 */
export function detectMainStatementKeyword(statement: string): string {
  const tokens = tokenizeSql(statement.trim());
  const words = topLevelWords(tokens);
  if (words.length === 0) return '';
  if (words[0] === 'WITH') {
    return words.slice(1).find((word) => MAIN_STATEMENT_KEYWORDS.has(word)) || 'WITH';
  }
  return words[0];
}

export function classifySqlStatement(statement: string): SqlClassification {
  const trimmed = statement.trim();
  if (!trimmed || trimmed === ';') {
    return { operation: 'neutral', returnsRows: false, keyword: '' };
  }

  const tokens = tokenizeSql(trimmed);
  const words = topLevelWords(tokens);
  if (words.length === 0) {
    // Comment-only statement.
    return { operation: 'neutral', returnsRows: false, keyword: '' };
  }
  const first = words[0];
  const returnsRows = hasKeyword(tokens, 'RETURNING');

  switch (first) {
    case 'SELECT':
    case 'VALUES':
    case 'EXPLAIN':
      return { operation: 'read', returnsRows: true, keyword: first };
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'REPLACE':
      return { operation: 'write', returnsRows, keyword: first };
    case 'CREATE':
    case 'DROP':
    case 'ALTER':
    case 'ATTACH':
    case 'DETACH':
    case 'VACUUM':
    case 'ANALYZE':
    case 'REINDEX':
      return { operation: 'write', returnsRows: false, keyword: first };
    case 'BEGIN':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
      return { operation: 'neutral', returnsRows: false, keyword: first };
    case 'PRAGMA':
      return classifyPragma(tokens);
    case 'WITH': {
      const main = words.slice(1).find((word) => MAIN_STATEMENT_KEYWORDS.has(word));
      if (!main) {
        return { operation: 'unknown', returnsRows: true, keyword: first };
      }
      if (main === 'SELECT' || main === 'VALUES') {
        return { operation: 'read', returnsRows: true, keyword: first };
      }
      return { operation: 'write', returnsRows, keyword: first };
    }
    default:
      return { operation: 'unknown', returnsRows: true, keyword: first };
  }
}

