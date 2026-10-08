/**
 * Normalise restore/import results for the Data & Privacy tab (U4/U5).
 * backupService has returned a boolean, `{ success, message }`,
 * `{ success, error, ... }` and `{ success, message, skippedKeys: {key, reason}[] }`
 * over time; reading `unknown` keeps the UI working across those shapes.
 */

export interface ActionOutcome {
  ok: boolean;
  /** The service's own explanation (error when it failed), if any. */
  message: string | null;
  /** Keys that were not restored/imported, with the reason when known. */
  skippedKeys: string[];
}

/** Drop browser-only wording such as "Refresh the page to see updated data." (the UI offers "Reload now"). */
function stripReloadAdvice(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  return sentences
    .filter((s) => !/^\s*(please\s+)?(refresh|reload)\b/i.test(s))
    .join('')
    .trim();
}

function describeSkipped(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const { key, reason } = entry as { key?: unknown; reason?: unknown };
    if (typeof key === 'string') return typeof reason === 'string' && reason ? `${key} (${reason})` : key;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Read a restore/import result in any known shape. */
export function normalizeActionResult(result: unknown): ActionOutcome {
  if (typeof result === 'boolean') return { ok: result, message: null, skippedKeys: [] };
  if (!result || typeof result !== 'object') return { ok: false, message: null, skippedKeys: [] };
  const r = result as Record<string, unknown>;
  const ok = r.ok === true || r.success === true;
  const error = nonEmptyString(r.error);
  const message = nonEmptyString(r.message);
  const raw = ok ? (message ?? error) : (error ?? message);
  const text = raw ? stripReloadAdvice(raw) : '';
  const skippedKeys = Array.isArray(r.skippedKeys)
    ? r.skippedKeys.map(describeSkipped).filter((k): k is string => !!k)
    : [];
  return { ok, message: text || null, skippedKeys };
}
