/**
 * Philippine mobile numbers to E.164 (+639XXXXXXXXX). Accepts 09171234567, 9171234567, 639171234567 and +63 917 123 4567,
 * with spaces, dashes or brackets. Anything else (landlines, other countries, wrong length) returns null.
 */
export function normalizePhPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "");
  let m = /^\+?63(9\d{9})$/.exec(digits);
  if (m) return `+63${m[1]}`;
  m = /^0(9\d{9})$/.exec(digits);
  if (m) return `+63${m[1]}`;
  m = /^(9\d{9})$/.exec(digits);
  if (m) return `+63${m[1]}`;
  return null;
}

/** For display: +63 917 123 4567 */
export function formatPhPhone(e164: string): string {
  const m = /^\+63(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+63 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
