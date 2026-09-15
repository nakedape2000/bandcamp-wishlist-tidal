const SENSITIVE =
  /authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|cookie|code/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return value;
}

export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      event,
      ...(redact(fields) as Record<string, unknown>),
    }),
  );
}
