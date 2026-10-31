// Just enough RFC 5322 to triage mail: unfolded headers, encoded words,
// addresses and List-Unsubscribe targets.

export function parseHeaders(raw) {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const headers = {};
  let last = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Keep the first occurrence; later duplicates are usually relay noise.
    if (!(last in headers)) headers[last] = value;
  }
  for (const key of Object.keys(headers)) headers[key] = decodeWords(headers[key]);
  return headers;
}

export function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return text;
    }
  });
}

/** "Jane Doe <jane@x.com>" -> { name: 'Jane Doe', address: 'jane@x.com' } */
export function parseAddress(value = '') {
  const angle = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (angle) return { name: angle[1].trim() || angle[2], address: angle[2].trim().toLowerCase() };
  const bare = value.match(/[^\s<>"]+@[^\s<>"]+/);
  const address = bare ? bare[0].toLowerCase() : value.trim().toLowerCase();
  return { name: address, address };
}

/** Split a List-Unsubscribe header into its mailto and https targets. */
export function parseUnsubscribe(listUnsubscribe, listUnsubscribePost) {
  if (!listUnsubscribe) return null;
  const targets = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const https = targets.find((t) => /^https:\/\//i.test(t)) ?? null;
  const mailto = targets.find((t) => /^mailto:/i.test(t)) ?? null;
  const oneClick = Boolean(https && /List-Unsubscribe=One-Click/i.test(listUnsubscribePost ?? ''));
  return { https, mailto, oneClick };
}
