import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ping } from '../../src/api/client';
import {
  countsByState,
  getHeldDeletions,
  getLastRev,
  getLastSyncAt,
  getServerConfig,
  listPendingMetadata,
  syncedBytes,
  type StateCounts,
} from '../../src/db/queries';
import {
  applyHeldDeletions,
  dismissHeldDeletions,
  retryFailed,
  runSync,
} from '../../src/sync/engine';
import { useSyncStore } from '../../src/store/syncStore';
import { colors, formatBytes } from '../../src/ui/theme';

type Reachability = 'checking' | 'reachable' | 'unreachable' | 'unpaired';

export default function SyncScreen() {
  const sync = useSyncStore();
  const [reachability, setReachability] = useState<Reachability>('checking');
  const [serverName, setServerName] = useState<string | null>(null);
  const [counts, setCounts] = useState<StateCounts>({
    queued: 0,
    downloading: 0,
    synced: 0,
    failed: 0,
    total: 0,
  });
  const [bytes, setBytes] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastRev, setLastRev] = useState<number | null>(null);
  const [held, setHeld] = useState<string[] | null>(null);

  const refresh = useCallback(() => {
    setCounts(countsByState());
    setBytes(syncedBytes());
    setLastSyncAt(getLastSyncAt());
    setLastRev(getLastRev());
    setHeld(getHeldDeletions());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
      const cfg = getServerConfig();
      if (cfg === null) {
        setReachability('unpaired');
        return;
      }
      setServerName(cfg.name);
      setReachability('checking');
      let cancelled = false;
      ping(cfg)
        .then(() => {
          if (!cancelled) setReachability('reachable');
        })
        .catch(() => {
          if (!cancelled) setReachability('unreachable');
        });
      return () => {
        cancelled = true;
      };
    }, [refresh]),
  );

  const reachLabel: Record<Reachability, { text: string; color: string }> = {
    checking: { text: 'Checking…', color: colors.textDim },
    reachable: { text: 'Server reachable', color: colors.success },
    unreachable: { text: 'Server unreachable', color: colors.danger },
    unpaired: { text: 'Not paired', color: colors.warning },
  };

  const pct = sync.total > 0 ? Math.min(1, sync.done / sync.total) : 0;
  const serverId = getServerConfig()?.serverId;
  const pendingEdits = serverId === undefined ? 0 : listPendingMetadata(serverId).length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>{serverName ?? 'No server'}</Text>
          <Text style={[styles.reach, { color: reachLabel[reachability].color }]}>
            {reachLabel[reachability].text}
          </Text>
        </View>
        <Text style={styles.dim}>
          Last sync:{' '}
          {lastSyncAt !== null ? new Date(lastSyncAt).toLocaleString() : 'never'}
          {lastRev !== null ? `  ·  rev ${lastRev}` : ''}
        </Text>
      </View>

      {(sync.status === 'syncing' || sync.status === 'checking') && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {sync.status === 'checking' ? 'Checking for changes…' : 'Syncing'}
          </Text>
          {sync.status === 'syncing' && sync.total > 0 && (
            <View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
              </View>
              <Text style={styles.dim}>
                {sync.done} of {sync.total} downloads
                {sync.failed > 0 ? `  ·  ${sync.failed} failed` : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {sync.status === 'error' && sync.error !== undefined && (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.errorTitle}>Sync error</Text>
          <Text style={styles.errorText}>{sync.error}</Text>
        </View>
      )}

      {pendingEdits > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{pendingEdits} song {pendingEdits === 1 ? 'edit' : 'edits'} waiting to sync</Text>
          <Text style={styles.dim}>Saved on this phone. Connect to your desktop and tap Sync Now to upload.</Text>
          {sync.metadataError !== undefined && <Text style={styles.errorText}>{sync.metadataError}</Text>}
        </View>
      )}

      {held !== null && held.length > 0 && (
        <View style={[styles.card, styles.warningCard]}>
          <Text style={styles.warningTitle}>Large deletion held</Text>
          <Text style={styles.dim}>
            The server no longer has {held.length} tracks that are stored on this phone. Delete
            them here too?
          </Text>
          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.button, styles.dangerButton]}
              onPress={() => {
                applyHeldDeletions();
                refresh();
              }}
            >
              <Text style={styles.dangerButtonLabel}>Delete {held.length} tracks</Text>
            </Pressable>
            <Pressable
              style={styles.button}
              onPress={() => {
                dismissHeldDeletions();
                refresh();
              }}
            >
              <Text style={styles.buttonLabel}>Keep for now</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Library</Text>
        <View style={styles.statsGrid}>
          <Stat label="Synced" value={String(counts.synced)} color={colors.success} />
          <Stat label="Queued" value={String(counts.queued)} color={colors.textDim} />
          <Stat label="Downloading" value={String(counts.downloading)} color={colors.accent} />
          <Stat label="Failed" value={String(counts.failed)} color={colors.danger} />
        </View>
        <Text style={styles.dim}>On-device music: {formatBytes(bytes)}</Text>
      </View>

      {counts.failed > 0 && (
        <Pressable
          style={styles.button}
          onPress={() => {
            void retryFailed().then(refresh);
          }}
        >
          <Text style={styles.buttonLabel}>Retry {counts.failed} failed</Text>
        </Pressable>
      )}

      <Pressable
        style={[styles.button, styles.primaryButton]}
        onPress={() => {
          void runSync('manual').then(refresh);
        }}
      >
        <Text style={styles.primaryButtonLabel}>Sync Now</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
    gap: 8,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  reach: {
    fontSize: 13,
    fontWeight: '500',
  },
  dim: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden',
    marginVertical: 6,
  },
  progressFill: {
    height: 6,
    backgroundColor: colors.accent,
  },
  errorCard: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorTitle: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  warningCard: {
    borderColor: colors.warning,
    borderWidth: StyleSheet.hairlineWidth,
  },
  warningTitle: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  stat: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    color: colors.textDim,
    fontSize: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  button: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  dangerButton: {
    borderColor: colors.danger,
  },
  dangerButtonLabel: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: colors.accent,
  },
  primaryButtonLabel: {
    color: '#00131f',
    fontSize: 16,
    fontWeight: '700',
  },
});
