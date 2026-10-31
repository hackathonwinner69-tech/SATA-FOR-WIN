// Just enough RFC 5322 to triage mail: unfolded headers, encoded words,
// addresses and List-Unsubscribe targets.

/** Longest header value kept; anything past it is noise or an attack. */
export const HEADER_MAX = 2048;

export function parseHeaders(raw) {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const headers = Object.create(null);
  let last = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (last && headers[last].length < HEADER_MAX) headers[last] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      last = null;
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    // Keep the first occurrence; later duplicates are usually relay noise, and so are their folded lines.
    if (name in headers) {
      last = null;
      continue;
    }
    last = name;
    headers[name] = line.slice(colon + 1).trim();
  }
  for (const key of Object.keys(headers)) headers[key] = decodeWords(headers[key].slice(0, HEADER_MAX));
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

/**
 * A sender from an already-split name and address. A display name that looks
 * like an address ("support@paypal.com" <x@evil.test>) is not shown: the
 * address is the only part the sender cannot make up.
 */
export function toSender(name, address) {
  const addr = String(address ?? '').trim().toLowerCase();
  const display = decodeWords(String(name ?? '')).trim();
  return { name: display && !/[<@]/.test(display) ? display : addr, address: addr };
}

/** "Jane Doe <jane@x.com>" -> { name: 'Jane Doe', address: 'jane@x.com' } */
export function parseAddress(value = '') {
  const text = String(value ?? '');
  // The last <...> is the address; a display name can carry its own.
  const angle = [...text.matchAll(/<([^<>]*)>/g)].at(-1);
  if (angle) {
    const display = text.slice(0, angle.index).trim().replace(/^"(.*)"$/s, '$1');
    return toSender(display, angle[1]);
  }
  const bare = text.match(/[^\s<>"]+@[^\s<>"]+/);
  return toSender('', bare ? bare[0] : text);
}

/** A Date header (or anything Date accepts) as ISO text, or null when it is not a real date. */
export function isoDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An https: or mailto: URL safe to write as a Markdown autolink, or null. */
function safeLink(target, protocol) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== protocol) return null;
  if (protocol === 'https:' && !url.hostname) return null;
  // eslint-disable-next-line no-control-regex -- control characters would break the autolink
  if (/[\s<>\u0000-\u001f\u007f]/.test(url.href)) return null;
  return url.href;
}

/** Split a List-Unsubscribe header into its mailto and https targets. */
export function parseUnsubscribe(listUnsubscribe, listUnsubscribePost) {
  if (!listUnsubscribe) return null;
  const targets = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const https = targets.map((t) => safeLink(t, 'https:')).find(Boolean) ?? null;
  const mailto = targets.map((t) => safeLink(t, 'mailto:')).find(Boolean) ?? null;
  if (!https && !mailto) return null;
  const oneClick = Boolean(https && /List-Unsubscribe=One-Click/i.test(listUnsubscribePost ?? ''));
  return { https, mailto, oneClick };
}
