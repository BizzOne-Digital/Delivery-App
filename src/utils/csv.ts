/**
 * Minimal, dependency-free CSV writer.
 *
 * Values starting with = + - @ are prefixed with a single quote to prevent CSV
 * injection when the export is opened in a spreadsheet application.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return (columns ?? []).join(',');
  const headers = columns ?? Object.keys(rows[0]!);
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\r\n');
}

export function csvFileName(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.csv`;
}
