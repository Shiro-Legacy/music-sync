import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DEFAULT_PORT, QrPayloadSchema, type QrPayload } from '@music-sync/shared';

import { ping } from '../src/api/client';
import { getServerConfig, setHeldDeletions, setLastEtag, setServerConfig } from '../src/db/queries';
import { runSync } from '../src/sync/engine';
import { colors } from '../src/ui/theme';

type Mode = 'scan' | 'manual';

export default function PairScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('scan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanLock = useRef(false);

  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [token, setToken] = useState('');

  const connect = async (payload: QrPayload): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const info = await ping({ host: payload.host, port: payload.port, token: payload.token });
      const previous = getServerConfig();
      if (previous !== null && previous.serverId !== info.serverId) {
        // Pairing with a different server: drop the old server's manifest ETag
        // and any held deletions so the next sync fetches a fresh manifest and
        // re-plans against this server under the normal mass-delete guard.
        setLastEtag(null);
        setHeldDeletions(null);
      }
      setServerConfig({
        host: payload.host,
        port: payload.port,
        token: payload.token,
        serverId: info.serverId,
        name: info.name !== '' ? info.name : payload.name,
      });
      void runSync('manual');
      router.back();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      scanLock.current = false;
    } finally {
      setBusy(false);
    }
  };

  const handleScan = (data: string): void => {
    if (scanLock.current || busy) return;
    scanLock.current = true;
    try {
      const payload = QrPayloadSchema.parse(JSON.parse(data));
      void connect(payload);
    } catch {
      setError('That QR code is not a MusicSync pairing code.');
      // Let the user try again after a moment.
      setTimeout(() => {
        scanLock.current = false;
      }, 1500);
    }
  };

  const handleManualConnect = (): void => {
    const portNum = Number(port);
    if (host.trim() === '' || !Number.isInteger(portNum) || portNum <= 0 || token.trim() === '') {
      setError('Enter the server host, port and token.');
      return;
    }
    void connect({ v: 1, host: host.trim(), port: portNum, token: token.trim(), name: host.trim() });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.modeSwitch}>
          <Pressable
            onPress={() => setMode('scan')}
            style={[styles.modeButton, mode === 'scan' && styles.modeActive]}
          >
            <Text style={[styles.modeLabel, mode === 'scan' && styles.modeLabelActive]}>
              Scan QR
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setMode('manual')}
            style={[styles.modeButton, mode === 'manual' && styles.modeActive]}
          >
            <Text style={[styles.modeLabel, mode === 'manual' && styles.modeLabelActive]}>
              Manual
            </Text>
          </Pressable>
        </View>

        {mode === 'scan' && (
          <View style={styles.scanArea}>
            {permission?.granted === true ? (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(result) => handleScan(result.data)}
              />
            ) : (
              <View style={styles.permissionBox}>
                <Text style={styles.dim}>
                  MusicSync needs camera access to scan the pairing QR code shown by your desktop
                  server.
                </Text>
                <Pressable
                  style={styles.button}
                  onPress={() => {
                    if (permission?.canAskAgain === false) {
                      void Linking.openSettings();
                    } else {
                      void requestPermission();
                    }
                  }}
                >
                  <Text style={styles.buttonLabel}>
                    {permission?.canAskAgain === false ? 'Open Settings' : 'Allow camera'}
                  </Text>
                </Pressable>
              </View>
            )}
            <Text style={styles.dim}>
              On your computer, run the server and point the camera at the QR code it prints.
            </Text>
          </View>
        )}

        {mode === 'manual' && (
          <View style={styles.form}>
            <Text style={styles.fieldLabel}>Host</Text>
            <TextInput
              style={styles.input}
              placeholder="192.168.1.20"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              value={host}
              onChangeText={setHost}
            />
            <Text style={styles.fieldLabel}>Port</Text>
            <TextInput
              style={styles.input}
              placeholder={String(DEFAULT_PORT)}
              placeholderTextColor={colors.textDim}
              keyboardType="number-pad"
              value={port}
              onChangeText={setPort}
            />
            <Text style={styles.fieldLabel}>Token</Text>
            <TextInput
              style={styles.input}
              placeholder="Pairing token from the server"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              value={token}
              onChangeText={setToken}
            />
            <Pressable
              style={[styles.button, styles.primaryButton, busy && styles.disabled]}
              disabled={busy}
              onPress={handleManualConnect}
            >
              <Text style={styles.primaryLabel}>{busy ? 'Connecting…' : 'Connect'}</Text>
            </Pressable>
          </View>
        )}

        {error !== null && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.dim}>
              Can't reach the server at all? Make sure this phone and your computer are on the same
              Wi-Fi, and that MusicSync is allowed to use the local network (Settings → Privacy →
              Local Network).
            </Text>
            <Pressable style={styles.button} onPress={() => void Linking.openSettings()}>
              <Text style={styles.buttonLabel}>Open Settings</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    gap: 16,
    paddingBottom: 60,
  },
  modeSwitch: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 9,
    padding: 2,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: 'center',
  },
  modeActive: {
    backgroundColor: colors.border,
  },
  modeLabel: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  modeLabelActive: {
    color: colors.text,
  },
  scanArea: {
    gap: 12,
  },
  camera: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  permissionBox: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 20,
    gap: 14,
    alignItems: 'center',
  },
  form: {
    gap: 8,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: 6,
  },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
  },
  button: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: colors.accent,
    marginTop: 12,
  },
  primaryLabel: {
    color: '#00131f',
    fontSize: 16,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.6,
  },
  errorCard: {
    backgroundColor: colors.card,
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 19,
  },
  dim: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
});
