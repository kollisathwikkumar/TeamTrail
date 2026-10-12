export function apiTokenHeaders(token: string | null | undefined): Record<string, string> {
  const normalized = token?.trim();
  return normalized ? { Authorization: `Bearer ${normalized}` } : {};
}
