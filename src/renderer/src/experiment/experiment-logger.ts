type Primitive = string | number | boolean | null | undefined
export function csvEscape(value: Primitive): string {
  if (value == null) return ''
  const raw = String(value)
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`
  return raw
}

export function toCsv<T extends object>(headers: Array<keyof T & string>, rows: T[]): string {
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] as Primitive)).join(','))
  }
  return '\uFEFF' + lines.join('\n')
}

export function payloadJson(payload: unknown): string {
  return JSON.stringify(payload)
}

export function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}
