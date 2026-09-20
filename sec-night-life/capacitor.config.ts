import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Production: loads bundled web assets from `dist/`.
 * Dev live-reload: uncomment server.url (LAN IP + Vite port) — never ship enabled.
 */
const config: CapacitorConfig = {
  appId: 'com.secnightlife.app',
  appName: 'SEC Nightlife',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    // url: 'http://192.168.1.100:5173',
    // cleartext: true,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      // Android: 0 avoids OnPreDrawListener stuck-splash races (hide via capacitorNative timers).
      // iOS LaunchScreen uses SEC Splash.imageset; web hideNativeSplash runs after first paint.
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#000000',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
