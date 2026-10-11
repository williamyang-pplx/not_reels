export function cleanUrl(input: string): string {
  const u = new URL(input);
  u.search = '';
  u.hash = '';
  return u.toString();
}
