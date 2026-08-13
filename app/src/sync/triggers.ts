import * as Network from 'expo-network';
import { AppState } from 'react-native';

import { runSync } from './engine';

const FOREGROUND_THROTTLE_MS = 60_000;

let initialized = false;
let lastForegroundSync = 0;

/**
 * Foreground + network sync triggers. Call once from the root layout.
 * (The periodic background trigger lives in ./background.ts.)
 */
export function initTriggers(): void {
  if (initialized) return;
  initialized = true;

  AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    const now = Date.now();
    if (now - lastForegroundSync < FOREGROUND_THROTTLE_MS) return;
    lastForegroundSync = now;
    void runSync('foreground');
  });

  Network.addNetworkStateListener((event) => {
    if (event.type === Network.NetworkStateType.WIFI && event.isConnected === true) {
      void runSync('network');
    }
  });
}
