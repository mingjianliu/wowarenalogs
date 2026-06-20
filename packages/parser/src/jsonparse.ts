function isNumericToken(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  let hasDecimal = false;
  let start = 0;
  if (value[0] === '-') {
    start = 1;
    if (value.length === 1) return false;
  }
  for (let i = start; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      continue;
    }
    if (c === 46) {
      if (hasDecimal) return false;
      hasDecimal = true;
      continue;
    }
    return false;
  }
  return true;
}

function isAllZeros(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== 48) {
      return false;
    }
  }
  return true;
}

function parseToken(token: string): unknown {
  if (token.length === 0) {
    return '';
  }

  if (token[0] === '"' && token[token.length - 1] === '"') {
    return token.slice(1, -1).replaceAll('\\"', '"');
  }

  const firstChar = token[0];
  const lastChar = token[token.length - 1];
  if ((firstChar === '[' || firstChar === '(') && (lastChar === ']' || lastChar === ')')) {
    return parseFields(token.slice(1, -1));
  }

  if (isNumericToken(token)) {
    if (isAllZeros(token)) {
      return 0;
    }
    const val = Number(token);
    return isNaN(val) ? token : val;
  }

  return token;
}

function parseFields(str: string): unknown[] {
  if (str.length === 0) {
    return [];
  }

  const fields: unknown[] = [];
  let i = 0;
  const len = str.length;
  let currentStart = 0;
  let depth = 0;
  let insideQuote = false;

  while (i < len) {
    const char = str[i];
    if (insideQuote) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '"') {
        insideQuote = false;
      }
    } else {
      if (char === '"') {
        insideQuote = true;
      } else if (char === '(' || char === '[') {
        depth++;
      } else if (char === ')' || char === ']') {
        depth--;
      } else if (char === ',' && depth === 0) {
        fields.push(parseToken(str.slice(currentStart, i)));
        currentStart = i + 1;
      }
    }
    i++;
  }
  fields.push(parseToken(str.slice(currentStart)));
  return fields;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseWowToJSON(logline: string): any {
  return {
    data: parseFields(logline),
  };
}
