import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { runMigrations } from '../src/db/schema';
import { setupPlayerOnce } from '../src/player/setup';
import { registerBackgroundSync } from '../src/sync/background';
import { initSyncEngine, runSync } from '../src/sync/engine';
import { initTriggers } from '../src/sync/triggers';
import { colors } from '../src/ui/theme';

// Migrations must complete before any screen touches the db.
runMigrations();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

export default function RootLayout() {
  useEffect(() => {
    void (async () => {
      await setupPlayerOnce();
      await initSyncEngine();
      initTriggers();
      await registerBackgroundSync();
      void runSync('foreground');
    })();
  }, []);

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="player" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with Server' }} />
      </Stack>
    </ThemeProvider>
  );
}
