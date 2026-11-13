const HTTP_PROTOCOL = /^https?:\/\//i;
const ANY_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;

/** Normalize a hotel website entered as a domain or an HTTP(S) URL. */
export function normalizeWebsiteUrl(value: string): string {
  const input = value.trim();
  if (!input) return '';
  if (ANY_PROTOCOL.test(input) && !HTTP_PROTOCOL.test(input)) {
    throw new Error('Só são permitidos endereços HTTP ou HTTPS.');
  }
  const candidate = HTTP_PROTOCOL.test(input) ? input : `https://${input}`;
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new Error('Indica um endereço de website válido.'); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || /\s/.test(input)) {
    throw new Error('Indica um endereço de website válido.');
  }
  if (url.pathname === '/' && !url.search && !url.hash) return url.origin;
  return url.href;
}
