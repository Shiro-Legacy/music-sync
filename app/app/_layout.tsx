import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { runMigrations } from '../src/db/schema';
import { setupPlayerOnce } from '../src/player/setup';
import { initVolumeLeveling } from '../src/player/volume';
import { registerBackgroundSync } from '../src/sync/background';
import { initSyncEngine, runSync } from '../src/sync/engine';
import { initTriggers } from '../src/sync/triggers';
import { MiniPlayer } from '../src/ui/MiniPlayer';
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
      initVolumeLeveling();
      await initSyncEngine();
      initTriggers();
      await registerBackgroundSync();
      void runSync('foreground');
    })();
  }, []);

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.bg },
            // Detail screens are reachable from several tabs, so a text back
            // label would often name the wrong origin — chevron only.
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {/* fullScreenModal, not 'modal': the sheet's pull-down recognizer cancels
              seek-bar drags even with gestureEnabled: false (verified on device). */}
          <Stack.Screen
            name="player"
            options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with Server' }} />
        </Stack>
        <MiniPlayer />
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
