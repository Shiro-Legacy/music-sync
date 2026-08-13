import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { runSync } from './engine';

export const BACKGROUND_SYNC_TASK = 'music-sync-background';

// Must run at module scope so the task exists on headless background launches.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    await runSync('background');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 60 });
  } catch (e) {
    console.warn('[sync] background task registration failed', e);
  }
}
