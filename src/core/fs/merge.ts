/** Union two string lists preserving order and dropping duplicates. */
export function mergeStringList(existing: string[] = [], incoming: string[] = []): string[] {
  const out = [...existing];
  for (const item of incoming) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

type AnyRecord = Record<string, any>;

/**
 * Deep-merge a Reins `.claude/settings.json` fragment into an existing one
 * without clobbering the user's content:
 *  - `hooks`: per event, append incoming entries that are not already present.
 *  - `permissions.{allow,ask,deny}`: union of patterns.
 *  - any other top-level key: only added when missing.
 */
export function deepMergeSettings(existing: AnyRecord, incoming: AnyRecord): AnyRecord {
  const result: AnyRecord = structuredClone(existing ?? {});

  if (incoming?.hooks && typeof incoming.hooks === "object") {
    result.hooks = (result.hooks as AnyRecord) ?? {};
    for (const [event, entries] of Object.entries(incoming.hooks)) {
      if (!Array.isArray(entries)) continue;
      const current: any[] = Array.isArray(result.hooks[event]) ? result.hooks[event] : [];
      const seen = new Set(current.map((e) => JSON.stringify(e)));
      for (const entry of entries) {
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          current.push(entry);
          seen.add(key);
        }
      }
      result.hooks[event] = current;
    }
  }

  if (incoming?.permissions && typeof incoming.permissions === "object") {
    result.permissions = (result.permissions as AnyRecord) ?? {};
    for (const bucket of ["allow", "ask", "deny"] as const) {
      if (Array.isArray(incoming.permissions[bucket])) {
        result.permissions[bucket] = mergeStringList(
          result.permissions[bucket],
          incoming.permissions[bucket],
        );
      }
    }
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (key === "hooks" || key === "permissions") continue;
    if (!(key in result)) result[key] = value;
  }

  return result;
}
