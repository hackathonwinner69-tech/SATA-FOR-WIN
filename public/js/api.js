// Talks to the local ChoreCade server with the token the page was served with.
const token = document.querySelector('meta[name="chorecade-token"]').content;

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-chorecade-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

export function listen(onEvent) {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
  return () => source.close();
}

export const fmt = {
  n: (v) => Math.round(v ?? 0).toLocaleString(),
  money: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`,
  bytes(v = 0) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
  },
};
