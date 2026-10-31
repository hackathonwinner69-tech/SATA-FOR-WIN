// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines in quotes.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Excel and Sheets run a cell that starts with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\$?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/;

/** Prefix formula-like cells with ' so a spreadsheet shows them as text; -12.50 stays a number. */
function defuse(s) {
  if (!FORMULA_START.test(s) || (/\d/.test(s) && PLAIN_NUMBER.test(s))) return s;
  return `'${s}`;
}

function quote(value) {
  const s = defuse(value == null ? '' : String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}
