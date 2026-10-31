// Export the reviewed expenses to a new Google Sheet: one tab of every
// transaction with its category, one tab of totals.
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function exportToSheets(auth, { title, tabs }) {
  const sheet = await auth.api(API, {
    method: 'POST',
    body: {
      properties: { title },
      sheets: tabs.map((t) => ({ properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } })),
    },
  });
  await auth.api(`${API}/${sheet.spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: {
      // RAW, never USER_ENTERED: a merchant called "=IMPORTXML(...)" must stay text, not become a formula.
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({ range: `'${t.name.replace(/'/g, "''")}'!A1`, values: t.rows })),
    },
  });
  return { id: sheet.spreadsheetId, url: sheet.spreadsheetUrl };
}
