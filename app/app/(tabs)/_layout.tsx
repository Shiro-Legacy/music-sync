import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { MiniPlayer } from '../../src/ui/MiniPlayer';
import { colors } from '../../src/ui/theme';

function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={[styles.glyph, { color }]}>{glyph}</Text>;
}

export default function TabsLayout() {
  return (
    <View style={styles.container}>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitleStyle: { color: colors.text },
          headerShadowVisible: false,
          tabBarStyle: {
            backgroundColor: colors.bg,
            borderTopColor: colors.border,
          },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textDim,
          sceneStyle: { backgroundColor: colors.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Library',
            tabBarIcon: ({ color }) => <TabGlyph glyph="♪" color={String(color)} />,
          }}
        />
        <Tabs.Screen
          name="playlists"
          options={{
            title: 'Playlists',
            tabBarIcon: ({ color }) => <TabGlyph glyph="≡" color={String(color)} />,
          }}
        />
        <Tabs.Screen
          name="sync"
          options={{
            title: 'Sync',
            tabBarIcon: ({ color }) => <TabGlyph glyph="⇅" color={String(color)} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color }) => <TabGlyph glyph="⚙" color={String(color)} />,
          }}
        />
      </Tabs>
      <MiniPlayer />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  glyph: {
    fontSize: 20,
  },
});
