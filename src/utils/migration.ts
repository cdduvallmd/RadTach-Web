import { firestoreService } from '../services/firestore';

/**
 * One-time migration: reads localStorage settings and pushes to Firestore.
 * Sets `radtach_migrated` flag only after a successful Firestore write.
 * Returns true if migration was performed, false if skipped or no data to migrate.
 */
export const migrateLocalStorageToFirestore = async (userId: string): Promise<boolean> => {
  if (localStorage.getItem('radtach_migrated') === 'true') {
    return false;
  }

  try {
    const parTimes = localStorage.getItem('radtach_parTimes');
    const rvuValues = localStorage.getItem('radtach_rvuValues');
    const stealthMode = localStorage.getItem('radtach_stealthMode');
    const autoStartEnabled = localStorage.getItem('radtach_autoStart');
    const useHMSFormat = localStorage.getItem('radtach_useHMSFormat');

    // Build settings object, only including non-null values
    const settings: Record<string, unknown> = {};
    if (parTimes) settings.parTimes = JSON.parse(parTimes);
    if (rvuValues) settings.rvuValues = JSON.parse(rvuValues);
    if (stealthMode !== null) settings.stealthMode = JSON.parse(stealthMode);
    if (autoStartEnabled !== null) settings.autoStartEnabled = JSON.parse(autoStartEnabled);
    if (useHMSFormat !== null) settings.useHMSFormat = JSON.parse(useHMSFormat);

    // Only write if there's something to migrate
    if (Object.keys(settings).length === 0) {
      return false;
    }

    await firestoreService.saveUserSettings(userId, settings);
    localStorage.setItem('radtach_migrated', 'true');
    return true;
  } catch (error) {
    console.error('Migration failed:', error);
    return false;
  }
};
