export interface ImportedStateV1 {
  schema_version: 1;
  imported_at: string;
  source_files: Record<
    string,
    { present: boolean; record_count: number | null }
  >;
}

export function buildImportState(
  files: Record<string, unknown>,
): ImportedStateV1 {
  const source_files: ImportedStateV1["source_files"] = {};
  for (const [name, value] of Object.entries(files)) {
    source_files[name] = {
      present: value !== undefined,
      record_count: Array.isArray(value)
        ? value.length
        : value &&
            typeof value === "object" &&
            "items" in value &&
            Array.isArray(value.items)
          ? value.items.length
          : null,
    };
  }
  return {
    schema_version: 1,
    imported_at: new Date().toISOString(),
    source_files,
  };
}
