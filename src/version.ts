/**
 * The app version, read from package.json at build time (Vite inlines only the
 * `version` field), so backup/export metadata always reports the real version.
 */
import { version as packageVersion } from '../package.json';

/** Current app version, e.g. "1.0.6". */
export const APP_VERSION: string = packageVersion;
