import type { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'dev';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? 'MusicSync (Dev)' : 'MusicSync',
  slug: 'musicsync',
  scheme: IS_DEV ? 'musicsync-dev' : 'musicsync',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  ios: {
    supportsTablet: false,
    bundleIdentifier: IS_DEV ? 'com.jiaqi.musicsync.dev' : 'com.jiaqi.musicsync',
    // TODO: set to the personal-team ID once device signing is set up
    // (MAC-SETUP §3; find it with `security find-identity -v -p codesigning`).
    // appleTeamId: 'XXXXXXXXXX',
    infoPlist: {
      NSAppTransportSecurity: {
        // The desktop server speaks plain HTTP on the LAN.
        NSAllowsLocalNetworking: true,
      },
      NSLocalNetworkUsageDescription:
        'Connects to your computer on your home Wi-Fi to sync your music library.',
      UIBackgroundModes: ['audio'],
    },
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-background-task',
    [
      'expo-camera',
      {
        cameraPermission:
          'MusicSync uses the camera to scan the pairing QR code shown by your desktop server.',
      },
    ],
    // Ships its own config plugin (app.plugin.js) for iOS AppDelegate wiring.
    '@kesha-antonov/react-native-background-downloader',
  ],
  extra: {
    // Used by Settings for the "built N days ago" free-provisioning re-sign nudge.
    buildDate: new Date().toISOString(),
  },
});
