import TrackPlayer from 'react-native-track-player';

import { playbackService } from './src/player/service';
// Ensure the background sync task is defined at module scope for headless launches.
import './src/sync/background';

// Register the playback service BEFORE the router app loads (documented RNTP +
// expo-router pattern). Static imports hoist, so the router entry is loaded via
// require() to guarantee it runs after registration.
TrackPlayer.registerPlaybackService(() => playbackService);

require('expo-router/entry');
