/**
 * Reload the whole app (desktop and web). Settings routes every reload
 * (after a restore, an import, deleting all data, or reopening the plan
 * picker) through here so tests can mock it.
 */
export function reloadApp(): void {
  window.location.reload();
}
