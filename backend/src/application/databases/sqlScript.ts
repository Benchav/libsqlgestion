const STRING_DELIMITERS = new Set(['"', "'", '`']);

export function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = '';
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' = 'normal';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      current += char;
      if (char === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        state = 'normal';
      }
      continue;
    }

    if (state === 'single') {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
        continue;
      }
      if (char === "'") state = 'normal';
      continue;
    }

    if (state === 'double') {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
        continue;
      }
      if (char === '"') state = 'normal';
      continue;
    }

    if (state === 'backtick') {
      current += char;
      if (char === '`') state = 'normal';
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      index += 1;
      state = 'line-comment';
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      index += 1;
      state = 'block-comment';
      continue;
    }

    if (STRING_DELIMITERS.has(char)) {
      current += char;
      state = char === '"' ? 'double' : char === '`' ? 'backtick' : 'single';
      continue;
    }

    if (char === ';') {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

export function isMultiStatementSql(sql: string) {
  return splitSqlStatements(sql).length > 1;
}
