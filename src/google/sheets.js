// Export the reviewed expenses to a new Google Sheet: one tab of every
// transaction with its category, one tab of totals.
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
// Google suggests keeping a request under about 2 MB; stay well below that.
const REQUEST_BYTES = 1_000_000;

/** The values:batchUpdate `data` for each request, splitting tabs by whole rows so no request gets too big. */
export function valueRequests(tabs, limit = REQUEST_BYTES) {
  const requests = [];
  let data = [];
  let size = 0;
  for (const tab of tabs) {
    const sheet = `'${tab.name.replace(/'/g, "''")}'`;
    let range = null;
    tab.rows.forEach((row, r) => {
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size && size + bytes > limit) {
        requests.push(data);
        data = [];
        size = 0;
        range = null;
      }
      if (!range) {
        range = { range: `${sheet}!A${r + 1}`, values: [] };
        data.push(range);
        size += Buffer.byteLength(range.range) + 32;
      }
      range.values.push(row);
      size += bytes;
    });
  }
  if (data.length) requests.push(data);
  return requests;
}

/** In a dry run nothing is created; the result is what would have been exported. */
export async function exportToSheets(auth, { title, tabs }, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, id: null, url: null, title, tabs };
  const sheet = await auth.api(API, {
    method: 'POST',
    query: { fields: 'spreadsheetId,spreadsheetUrl' },
    body: {
      properties: { title },
      sheets: tabs.map((t) => ({ properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } })),
    },
  });
  try {
    for (const data of valueRequests(tabs)) {
      // Overwriting the same cells again is harmless, so this write may be retried.
      // RAW, never USER_ENTERED: a merchant called "=IMPORTXML(...)" must stay text, not become a formula.
      await auth.api(`${API}/${sheet.spreadsheetId}/values:batchUpdate`, { method: 'POST', idempotent: true, body: { valueInputOption: 'RAW', data } });
    }
  } catch (err) {
    const message = `created the spreadsheet ${sheet.spreadsheetUrl} but could not fill it in (${err.message}); open it to see what was written, or delete it and export again`;
    throw Object.assign(new Error(message, { cause: err }), { status: err.status, url: sheet.spreadsheetUrl });
  }
  return { id: sheet.spreadsheetId, url: sheet.spreadsheetUrl };
}
