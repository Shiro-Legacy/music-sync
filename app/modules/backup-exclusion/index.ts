import { requireOptionalNativeModule } from 'expo';

interface BackupExclusionNativeModule {
  setExcludedFromBackup(path: string): boolean;
}

const native = requireOptionalNativeModule<BackupExclusionNativeModule>('BackupExclusion');

/**
 * Marks a file or directory as excluded from iCloud backup.
 * Accepts a `file://` URI or a plain path. No-ops (returns false) when the
 * native module is unavailable (e.g. Expo Go, web, or before a rebuild).
 */
export function setExcludedFromBackup(pathOrUri: string): boolean {
  if (!native) return false;
  const path = pathOrUri.startsWith('file://')
    ? decodeURIComponent(pathOrUri.slice('file://'.length))
    : pathOrUri;
  try {
    return native.setExcludedFromBackup(path);
  } catch {
    return false;
  }
}
