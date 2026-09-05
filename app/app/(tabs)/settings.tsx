import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import TrackPlayer from 'react-native-track-player';

import {
  countsByState,
  getServerConfig,
  syncedBytes,
  type ServerConfig,
} from '../../src/db/queries';
import { setVolumeLeveling } from '../../src/player/volume';
import { usePlayerStore } from '../../src/store/playerStore';
import { wipeLocalLibrary } from '../../src/sync/engine';
import { colors, formatBytes } from '../../src/ui/theme';

const RESIGN_WARNING_DAYS = 5;

function buildAge(): { days: number; label: string } | null {
  const extra = Constants.expoConfig?.extra as { buildDate?: string } | undefined;
  const raw = extra?.buildDate;
  if (raw === undefined) return null;
  const built = Date.parse(raw);
  if (Number.isNaN(built)) return null;
  const days = Math.floor((Date.now() - built) / 86_400_000);
  if (days <= 0) return { days, label: 'built today' };
  if (days === 1) return { days, label: 'built yesterday' };
  return { days, label: `built ${days} days ago` };
}

export default function SettingsScreen() {
  const router = useRouter();
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [bytes, setBytes] = useState(0);
  const [trackCount, setTrackCount] = useState(0);
  const leveling = usePlayerStore((s) => s.leveling);

  const refresh = useCallback(() => {
    setCfg(getServerConfig());
    setBytes(syncedBytes());
    setTrackCount(countsByState().total);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const age = buildAge();

  const confirmWipe = () => {
    Alert.alert(
      'Wipe local library?',
      `This deletes all ${trackCount} tracks (${formatBytes(bytes)}) from this phone. Your desktop library is not touched; the next sync will re-download everything.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await TrackPlayer.reset();
              } catch {
                // player may not be running — fine
              }
              wipeLocalLibrary();
              refresh();
            })();
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Paired server</Text>
        {cfg !== null ? (
          <View style={styles.kvList}>
            <KV label="Name" value={cfg.name} />
            <KV label="Address" value={`${cfg.host}:${cfg.port}`} />
            <KV label="Server ID" value={`${cfg.serverId.slice(0, 12)}…`} />
          </View>
        ) : (
          <Text style={styles.dim}>Not paired yet.</Text>
        )}
        <Pressable style={styles.button} onPress={() => router.push('/pair')}>
          <Text style={styles.buttonLabel}>{cfg !== null ? 'Re-pair' : 'Pair with server'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Storage</Text>
        <View style={styles.kvList}>
          <KV label="Tracks" value={String(trackCount)} />
          <KV label="Music on device" value={formatBytes(bytes)} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Playback</Text>
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.kvValue}>Volume leveling</Text>
            <Text style={styles.dim}>
              Plays every song at the same loudness using the level measured by your server.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Volume leveling"
            value={leveling}
            onValueChange={(on) => {
              void setVolumeLeveling(on);
            }}
            trackColor={{ true: colors.accent }}
          />
        </View>
      </View>

      {age !== null && (
        <View style={[styles.card, age.days > RESIGN_WARNING_DAYS && styles.warningCard]}>
          <Text style={styles.cardTitle}>App build</Text>
          <Text style={styles.dim}>This build was {age.label}.</Text>
          {age.days > RESIGN_WARNING_DAYS && (
            <Text style={styles.warningText}>
              Free-provisioned builds stop launching after 7 days. Plug in and rebuild from your
              computer soon.
            </Text>
          )}
        </View>
      )}

      <Pressable style={[styles.button, styles.dangerButton]} onPress={confirmWipe}>
        <Text style={styles.dangerLabel}>Wipe local library</Text>
      </Pressable>
    </ScrollView>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.kvValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 140,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  dim: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  kvList: {
    gap: 6,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  kvLabel: {
    color: colors.textDim,
    fontSize: 14,
  },
  kvValue: {
    color: colors.text,
    fontSize: 14,
    flexShrink: 1,
  },
  button: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  warningCard: {
    borderColor: colors.warning,
    borderWidth: StyleSheet.hairlineWidth,
  },
  warningText: {
    color: colors.warning,
    fontSize: 13,
    lineHeight: 18,
  },
  dangerButton: {
    backgroundColor: colors.card,
    borderColor: colors.danger,
  },
  dangerLabel: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
});
