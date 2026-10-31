// Export the reviewed expenses to a new Google Sheet: one tab of every
// transaction with its category, one tab of totals.
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** In a dry run nothing is created; the result is what would have been exported. */
export async function exportToSheets(auth, { title, tabs }, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, id: null, url: null, title, tabs };
  const sheet = await auth.api(API, {
    method: 'POST',
    body: {
      properties: { title },
      sheets: tabs.map((t) => ({ properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } })),
    },
  });
  // Overwriting the same cells again is harmless, so this write may be retried.
  await auth.api(`${API}/${sheet.spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    idempotent: true,
    body: {
      // RAW, never USER_ENTERED: a merchant called "=IMPORTXML(...)" must stay text, not become a formula.
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({ range: `'${t.name.replace(/'/g, "''")}'!A1`, values: t.rows })),
    },
  });
  return { id: sheet.spreadsheetId, url: sheet.spreadsheetUrl };
}
