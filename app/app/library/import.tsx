import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ImportJob, ImportPreview } from '@music-sync/shared';

import { byId, getServerConfig, type ServerConfig, type TrackRow } from '../../src/db/queries';
import {
  fetchImportPreview,
  listImports,
  submitImport,
  type ImportServer,
} from '../../src/imports/client';
import { retryFailed, runSync } from '../../src/sync/engine';
import { useSyncStore } from '../../src/store/syncStore';
import { EmptyState } from '../../src/ui/EmptyState';
import { colors, formatDuration } from '../../src/ui/theme';

/** Jobs are polled ~2s, but only while this screen is focused + foregrounded. */
const POLL_MS = 2000;

function userMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return 'No response from the server — check your connection.';
    if (e instanceof TypeError) return 'Server unreachable — are you on the same Wi-Fi?';
    return e.message;
  }
  return String(e);
}

/** Local phone copy of a job's track, or null when the desktop hasn't shared it yet. */
function localRow(job: ImportJob): TrackRow | null {
  return job.trackId !== undefined ? byId(job.trackId) : null;
}

function stateChip(job: ImportJob): { label: string; color: string } {
  switch (job.state) {
    case 'queued':
      return { label: 'Queued', color: colors.textDim };
    case 'downloading':
      return {
        label: job.progress !== undefined ? `Downloading ${job.progress}%` : 'Downloading…',
        color: colors.accent,
      };
    case 'processing':
      return { label: 'Converting…', color: colors.warning };
    case 'indexing':
      return { label: 'Indexing…', color: colors.warning };
    case 'ready': {
      const local = localRow(job);
      if (local !== null && local.state === 'synced') return { label: 'On this phone', color: colors.success };
      if (local !== null && local.state === 'failed') return { label: 'Download failed on phone', color: colors.danger };
      if (local !== null) return { label: 'Syncing to phone…', color: colors.accent };
      return { label: 'Ready on server', color: colors.success };
    }
    case 'failed':
      return { label: 'Failed', color: colors.danger };
  }
}

export default function ImportScreen() {
  const router = useRouter();
  const sync = useSyncStore();

  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  /** Bumped on focus/blur so responses from a previous visit are dropped. */
  const session = useRef(0);
  /** Poll loop restarts when this changes (focus, submit, retry). */
  const [pollVersion, setPollVersion] = useState(0);
  /** Abortable handle for the current one-shot request (preview/submit/retry). */
  const opAbort = useRef<AbortController | null>(null);
  /** Ready jobs that already triggered a sync since this focus. */
  const attemptedSync = useRef(new Set<string>());
  /** serverId of the library the screen state was last rendered against. */
  const renderedLibrary = useRef<string | null>(null);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'preview' | 'submit' | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');

  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [availability, setAvailability] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  /** Records a fresh job list, guarded against a stale session or pairing change. */
  const applyList = useCallback((c: ImportServer, s: number, res: { jobs: ImportJob[] }) => {
    if (s !== session.current) return false;
    const now = getServerConfig();
    if (now === null || now.serverId !== c.serverId) return false; // pairing changed mid-flight
    setJobs(res.jobs);
    return true;
  }, []);

  // Pairing is read afresh on every focus; blur invalidates in-flight work.
  // Busy flags and retry bookkeeping are reset too, or a request aborted by
  // blur would leave the compose card disabled forever. When the pairing (and
  // therefore the library) changed, stale jobs/preview from the old library
  // are cleared: track ids can collide across libraries, so an old job's
  // trackId must never be looked up under the new pairing.
  useFocusEffect(
    useCallback(() => {
      session.current += 1;
      opAbort.current?.abort();
      opAbort.current = null;
      const c = getServerConfig();
      const library = c?.serverId ?? null;
      if (library !== renderedLibrary.current) {
        renderedLibrary.current = library;
        setJobs([]);
        setAvailability(null);
        setUnavailableReason(null);
        setPreview(null);
        setPreviewUrl(null);
        setUrl('');
        setTitle('');
        setArtist('');
        setThumbBroken(false);
        setPollError(null);
      }
      attemptedSync.current.clear();
      setBusy(null);
      setRetryingId(null);
      setActionError(null);
      setCfg(c);
      setFocused(true);
      return () => {
        session.current += 1;
        opAbort.current?.abort();
        opAbort.current = null;
        setFocused(false);
      };
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setForeground(true);
        return;
      }
      // Backgrounded: drop in-flight one-shot requests so late results can't
      // land, and reset busy flags the same way blur does.
      session.current += 1;
      opAbort.current?.abort();
      opAbort.current = null;
      setBusy(null);
      setRetryingId(null);
      setForeground(false);
    });
    return () => sub.remove();
  }, []);

  // Poll while focused + foregrounded: a self-rescheduling timeout (never a
  // fixed interval, so a slow server can't stack requests). The chain stops
  // once every job is terminal and resumes on focus or after a submit/retry.
  // Blur/unmount/background abort the in-flight request.
  useEffect(() => {
    if (!focused || !foreground || cfg === null) return;
    const s = session.current;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await listImports(cfg, controller.signal);
        if (cancelled) return;
        if (!applyList(cfg, s, res)) return;
        setAvailability(res.available);
        setUnavailableReason(res.unavailableReason ?? null);
        setPollError(null);
        const active = res.jobs.some((j) => j.state !== 'ready' && j.state !== 'failed');
        if (!cancelled && active) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (e) {
        if (cancelled) return;
        const now = getServerConfig();
        if (now === null || now.serverId !== cfg.serverId) return;
        setPollError(userMessage(e));
        // Keep retrying at the poll cadence so the screen self-heals when the server returns.
        if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [focused, foreground, cfg, pollVersion, applyList]);

  // A job that turned ready on the desktop needs a sync to reach this phone.
  // Same lifecycle gate as polling: only while this screen is focused and the
  // app is foregrounded, and only under the pairing this state was fetched
  // with. Fires at most once per job per focus, and only when the engine is
  // idle (or errored but the server is reachable again). If the call was
  // dropped by a concurrent sync or the sync failed to bring the row over,
  // there is no further automatic retry this focus — the row's Sync now /
  // Retry download buttons are the fallback; re-entering the screen retries.
  useEffect(() => {
    if (!focused || !foreground || cfg === null) return;
    if (getServerConfig()?.serverId !== cfg.serverId) return; // pairing changed since render
    if (sync.status !== 'idle' && !(sync.status === 'error' && pollError === null)) return;
    for (const job of jobs) {
      if (job.state !== 'ready') continue;
      if (attemptedSync.current.has(job.id)) continue;
      if (localRow(job) !== null) continue; // already on this phone
      attemptedSync.current.add(job.id);
      void runSync('manual');
      return; // one kick per idle window
    }
  }, [jobs, cfg, sync.status, pollError, focused, foreground]);

  /** True while the sync engine is actively working (idle/error are tappable). */
  const syncBusy = sync.status === 'checking' || sync.status === 'syncing';

  const beginRequest = (): { signal: AbortSignal; sessionId: number } => {
    opAbort.current?.abort();
    opAbort.current = new AbortController();
    return { signal: opAbort.current.signal, sessionId: session.current };
  };

  const handlePreview = async () => {
    const c = cfg;
    const trimmed = url.trim();
    if (c === null || trimmed === '') return;
    setBusy('preview');
    setActionError(null);
    const { signal, sessionId: s } = beginRequest();
    try {
      const p = await fetchImportPreview(c, trimmed, signal);
      if (s !== session.current) return;
      if (getServerConfig()?.serverId !== c.serverId) return;
      setPreview(p);
      setPreviewUrl(trimmed);
      setTitle(p.title);
      setArtist(p.artist);
      setThumbBroken(false);
    } catch (e) {
      if (s === session.current) setActionError(userMessage(e));
    } finally {
      if (s === session.current) setBusy(null);
    }
  };

  const handleSubmit = async (req: { url: string; title: string; artist: string }) => {
    const c = cfg;
    if (c === null) return;
    const { signal, sessionId: s } = beginRequest();
    try {
      const job = await submitImport(c, req, signal);
      if (s !== session.current) return;
      if (getServerConfig()?.serverId !== c.serverId) return;
      // Re-poll immediately: shows the new (or deduped existing) job.
      setPollVersion((v) => v + 1);
      return job;
    } catch (e) {
      if (s === session.current) setActionError(userMessage(e));
      return undefined;
    }
  };

  const handleAdd = async () => {
    const c = cfg;
    const trimmed = url.trim();
    if (c === null || preview === null || previewUrl !== trimmed) return;
    const t = title.trim();
    if (t === '') {
      setActionError('Give the import a title.');
      return;
    }
    setBusy('submit');
    setActionError(null);
    const s = session.current;
    const job = await handleSubmit({ url: previewUrl, title: t, artist: artist.trim() });
    if (s !== session.current) return;
    if (job !== undefined) {
      // Compose cleared for the next link; the job shows up under Recent.
      setPreview(null);
      setPreviewUrl(null);
      setUrl('');
      setTitle('');
      setArtist('');
    }
    if (s === session.current) setBusy(null);
  };

  const handleRetry = async (job: ImportJob) => {
    const c = cfg;
    if (c === null) return;
    setRetryingId(job.id);
    setActionError(null);
    const s = session.current;
    await handleSubmit({ url: job.url, title: job.title, artist: job.artist });
    if (s === session.current) setRetryingId(null);
  };

  const syncNow = (job: ImportJob) => {
    attemptedSync.current.delete(job.id);
    void runSync('manual');
  };

  const editUrl = (text: string) => {
    setUrl(text);
    // Any URL edit invalidates the fetched preview.
    setPreview(null);
    setPreviewUrl(null);
    setActionError(null);
  };

  const composeDisabled = busy !== null;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Import from YouTube' }} />

      {cfg === null ? (
        <View style={styles.center}>
          <EmptyState
            title="Not paired with a server"
            subtitle="Pair your phone with the desktop server to import songs."
          />
          <Pressable style={[styles.button, styles.primaryButton]} onPress={() => router.push('/pair')}>
            <Text style={styles.primaryButtonLabel}>Pair with server</Text>
          </Pressable>
        </View>
      ) : (
        // Everything scrolls (warnings, compose, recent list) so the keyboard
        // never covers the title/artist inputs or the Add button on small screens.
        <FlashList
          style={styles.list}
          data={jobs}
          keyExtractor={(job) => job.id}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View>
              {pollError !== null && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningTitle}>Can't reach your server</Text>
                  <Text style={styles.dim}>{pollError}</Text>
                </View>
              )}

              {availability === false && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningTitle}>Importing unavailable</Text>
                  <Text style={styles.dim}>
                    {unavailableReason ?? 'Importing from YouTube is off on your server right now.'}
                  </Text>
                </View>
              )}

              <View style={styles.card}>
                <TextInput
                  style={styles.input}
                  placeholder="Paste a YouTube link"
                  placeholderTextColor={colors.textDim}
                  value={url}
                  onChangeText={editUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  clearButtonMode="while-editing"
                  editable={!composeDisabled}
                  accessibilityLabel="YouTube link"
                />
                <Pressable
                  style={[
                    styles.button,
                    styles.primaryButton,
                    (url.trim() === '' || composeDisabled) && styles.buttonDisabled,
                  ]}
                  onPress={() => void handlePreview()}
                  disabled={url.trim() === '' || composeDisabled}
                  accessibilityLabel="Preview import"
                >
                  <Text style={styles.primaryButtonLabel}>
                    {busy === 'preview' ? 'Checking link…' : 'Preview'}
                  </Text>
                </Pressable>

                {preview !== null && (
                  <View style={styles.previewCard}>
                    <View style={styles.previewTop}>
                      {preview.thumbnailUrl !== undefined && !thumbBroken ? (
                        <Image
                          source={{ uri: preview.thumbnailUrl }}
                          style={styles.thumb}
                          onError={() => setThumbBroken(true)}
                          accessibilityLabel="Video thumbnail"
                        />
                      ) : (
                        <View style={[styles.thumb, styles.thumbPlaceholder]}>
                          <Text style={styles.thumbGlyph}>▶</Text>
                        </View>
                      )}
                      <View style={styles.previewMeta}>
                        <Text style={styles.dim}>Duration {formatDuration(preview.durationSec)}</Text>
                        <TextInput
                          style={styles.input}
                          placeholder="Title"
                          placeholderTextColor={colors.textDim}
                          value={title}
                          onChangeText={setTitle}
                          maxLength={300}
                          editable={!composeDisabled}
                          accessibilityLabel="Title"
                        />
                        <TextInput
                          style={styles.input}
                          placeholder="Artist"
                          placeholderTextColor={colors.textDim}
                          value={artist}
                          onChangeText={setArtist}
                          maxLength={300}
                          editable={!composeDisabled}
                          accessibilityLabel="Artist"
                        />
                      </View>
                    </View>
                    <Pressable
                      style={[
                        styles.button,
                        styles.primaryButton,
                        (title.trim() === '' || composeDisabled) && styles.buttonDisabled,
                      ]}
                      onPress={() => void handleAdd()}
                      disabled={title.trim() === '' || composeDisabled}
                      accessibilityLabel="Add import"
                    >
                      <Text style={styles.primaryButtonLabel}>
                        {busy === 'submit' ? 'Adding…' : 'Add to library'}
                      </Text>
                    </Pressable>
                  </View>
                )}

                {actionError !== null && (
                  <View style={styles.errorCard}>
                    <Text style={styles.errorText}>{actionError}</Text>
                  </View>
                )}
              </View>

              <View style={styles.listHeader}>
                <Text style={styles.sectionTitle}>Recent imports</Text>
              </View>
            </View>
          }
          ListEmptyComponent={
            pollError !== null ? (
              <EmptyState title="Retrying…" subtitle="Polling your server for import status." />
            ) : (
              <EmptyState
                title="No imports yet"
                subtitle="Paste a YouTube link above to import a song."
              />
            )
          }
          renderItem={({ item: job }) => {
            const chip = stateChip(job);
            const local = localRow(job);
            return (
              <View style={styles.jobRow}>
                <View style={styles.jobBody}>
                  <Text numberOfLines={1} style={styles.jobTitle}>
                    {job.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.jobSubtitle}>
                    {job.artist}
                    {job.error !== undefined && job.state === 'failed' ? ` — ${job.error}` : ''}
                  </Text>
                </View>
                <View style={styles.jobAction}>
                  <Text style={[styles.chip, { color: chip.color }]}>{chip.label}</Text>
                  {job.state === 'failed' && cfg !== null && (
                    <Pressable
                      style={[styles.button, retryingId === job.id && styles.buttonDisabled]}
                      onPress={() => void handleRetry(job)}
                      disabled={retryingId === job.id}
                      accessibilityLabel={`Retry ${job.title}`}
                    >
                      <Text style={styles.buttonLabel}>
                        {retryingId === job.id ? 'Retrying…' : 'Retry'}
                      </Text>
                    </Pressable>
                  )}
                  {job.state === 'ready' && local !== null && local.state === 'failed' && (
                    <Pressable
                      style={[styles.button, syncBusy && styles.buttonDisabled]}
                      onPress={() => void retryFailed()}
                      disabled={syncBusy}
                      accessibilityLabel={`Retry download of ${job.title}`}
                    >
                      <Text style={[styles.buttonLabel, styles.retryLabel]}>Retry download</Text>
                    </Pressable>
                  )}
                  {job.state === 'ready' && local === null && (
                    <Pressable
                      style={[styles.button, syncBusy && styles.buttonDisabled]}
                      onPress={() => syncNow(job)}
                      disabled={syncBusy}
                      accessibilityLabel={`Sync ${job.title}`}
                    >
                      <Text style={styles.buttonLabel}>Sync now</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  list: {
    flex: 1,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 10,
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
  dim: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: 15,
  },
  button: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  retryLabel: {
    color: colors.danger,
  },
  primaryButton: {
    backgroundColor: colors.accent,
  },
  primaryButtonLabel: {
    color: '#00131f',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  previewCard: {
    gap: 10,
  },
  previewTop: {
    flexDirection: 'row',
    gap: 12,
  },
  thumb: {
    width: 84,
    height: 84,
    borderRadius: 8,
    backgroundColor: colors.bg,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbGlyph: {
    color: colors.textDim,
    fontSize: 22,
  },
  previewMeta: {
    flex: 1,
    gap: 8,
  },
  errorCard: {
    backgroundColor: colors.card,
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 10,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  listHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: 160,
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  jobBody: {
    flex: 1,
    gap: 2,
  },
  jobTitle: {
    color: colors.text,
    fontSize: 15,
  },
  jobSubtitle: {
    color: colors.textDim,
    fontSize: 12,
  },
  jobAction: {
    alignItems: 'flex-end',
    gap: 6,
  },
  chip: {
    fontSize: 12,
    fontWeight: '600',
  },
});
