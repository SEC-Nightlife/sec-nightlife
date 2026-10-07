import React, { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { t } from '@/i18n/translations';
import { useAuth } from '@/lib/AuthContext';
import { apiPatch } from '@/api/client';

const STORAGE_KEY = 'sec-preferences';
export const FEED_SCOPES = ['local', 'national', 'worldwide'];

function normalizeFeedScope(v) {
  return FEED_SCOPES.includes(v) ? v : 'local';
}

function normalizeCurrency(v) {
  return typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null;
}
const PRIVACY_KEY = 'sec-privacy-settings';

const defaultPrefs = {
  theme: 'dark',
  language: 'en',
  /** What feeds show: near me, my country, or everywhere. */
  feedScope: 'local',
  /** ISO 4217 display currency; null follows the user's country. Charges stay in ZAR. */
  displayCurrency: null,
  notifications: {
    enabled: true,
    push: {
      eventReminders: true,
      tableInvitations: true,
      friendRequests: true,
      messages: true,
      promotions: true,
      appUpdates: true,
    },
    email: {
      eventReminders: true,
      promotions: true,
    },
  },
  location: {
    useLocation: false,
    distanceUnit: 'km',
    radiusKm: 25,
  },
};

const defaultPrivacy = {
  profilePublic: true,
  searchVisible: true,
  tablesVisible: true,
  allowMessages: true,
};

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultPrefs };
    const parsed = JSON.parse(raw);
    const notif = parsed.notifications || {};
    const loc = parsed.location || {};
    return {
      theme: ['dark', 'light'].includes(parsed.theme) ? parsed.theme : defaultPrefs.theme,
      language: parsed.language || defaultPrefs.language,
      feedScope: normalizeFeedScope(parsed.feedScope),
      displayCurrency: normalizeCurrency(parsed.displayCurrency),
      notifications: {
        enabled: notif.enabled ?? defaultPrefs.notifications.enabled,
        push: { ...defaultPrefs.notifications.push, ...(notif.push && typeof notif.push === 'object' ? notif.push : {}) },
        email: { ...defaultPrefs.notifications.email, ...(notif.email && typeof notif.email === 'object' ? notif.email : {}) },
      },
      location: {
        ...defaultPrefs.location,
        ...(loc && typeof loc === 'object' ? loc : {}),
        radiusKm: Number(loc?.radiusKm) > 0 ? Number(loc.radiusKm) : defaultPrefs.location.radiusKm,
      },
    };
  } catch {
    return { ...defaultPrefs };
  }
}

function loadPrivacyFromStorage() {
  try {
    const raw = localStorage.getItem(PRIVACY_KEY);
    if (!raw) return { ...defaultPrivacy };
    const parsed = JSON.parse(raw);
    return { ...defaultPrivacy, ...parsed };
  } catch {
    return { ...defaultPrivacy };
  }
}

function saveToStorage(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn('Failed to save preferences:', e);
  }
}

function savePrivacyToStorage(privacy) {
  try {
    localStorage.setItem(PRIVACY_KEY, JSON.stringify(privacy));
  } catch (e) {
    console.warn('Failed to save privacy settings:', e);
  }
}

function applyThemeToDocument(theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export const PreferencesContext = createContext(null);

export function PreferencesProvider({ children }) {
  const { isAuthenticated, userProfile } = useAuth();
  const [prefs, setPrefsState] = useState(loadFromStorage);
  const [privacy, setPrivacyState] = useState(loadPrivacyFromStorage);
  const [geoCoords, setGeoCoords] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const hydratedFromApi = useRef(false);
  const skipNextSync = useRef(false);

  useLayoutEffect(() => {
    applyThemeToDocument('dark');
  }, []);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!userProfile || hydratedFromApi.current) return;
    skipNextSync.current = true;
    if (userProfile.notification_prefs && typeof userProfile.notification_prefs === 'object') {
      const notif = userProfile.notification_prefs;
      setPrefsState((p) => ({
        ...p,
        notifications: {
          enabled: notif.enabled ?? p.notifications.enabled,
          push: { ...p.notifications.push, ...(notif.push || {}) },
          email: { ...p.notifications.email, ...(notif.email || {}) },
        },
      }));
    }
    const apiPrefs = userProfile.app_preferences;
    if (apiPrefs && typeof apiPrefs === 'object' && (apiPrefs.feedScope || apiPrefs.displayCurrency !== undefined)) {
      setPrefsState((p) => ({
        ...p,
        feedScope: apiPrefs.feedScope ? normalizeFeedScope(apiPrefs.feedScope) : p.feedScope,
        displayCurrency:
          apiPrefs.displayCurrency !== undefined ? normalizeCurrency(apiPrefs.displayCurrency) : p.displayCurrency,
      }));
    }
    if (userProfile.app_preferences?.location) {
      setPrefsState((p) => ({
        ...p,
        location: { ...p.location, ...userProfile.app_preferences.location },
      }));
    }
    if (userProfile.privacy_settings && typeof userProfile.privacy_settings === 'object') {
      setPrivacyState({ ...defaultPrivacy, ...userProfile.privacy_settings });
    }
    // Seed preferred location when location preference is already on
    if (
      userProfile.app_preferences?.location?.useLocation &&
      typeof userProfile.latitude === 'number' &&
      typeof userProfile.longitude === 'number' &&
      !Number.isNaN(userProfile.latitude) &&
      !Number.isNaN(userProfile.longitude)
    ) {
      setGeoCoords({ lat: userProfile.latitude, lng: userProfile.longitude });
    }
    hydratedFromApi.current = true;
  }, [userProfile]);

  useEffect(() => {
    if (!hydrated) return;
    saveToStorage(prefs);
  }, [prefs, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    savePrivacyToStorage(privacy);
  }, [privacy, hydrated]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    const timer = setTimeout(() => {
      apiPatch('/api/users/profile', {
        notification_prefs: prefs.notifications,
        app_preferences: {
          location: prefs.location,
          language: prefs.language,
          theme: prefs.theme,
          feedScope: prefs.feedScope,
          displayCurrency: prefs.displayCurrency,
        },
        privacy_settings: privacy,
      }).catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [
    prefs.notifications,
    prefs.location,
    prefs.language,
    prefs.feedScope,
    prefs.displayCurrency,
    privacy,
    hydrated,
    isAuthenticated,
  ]);

  const requestGeoCoords = useCallback(async () => {
    const { getCurrentLocation } = await import('@/lib/getCurrentLocation');
    const coords = await getCurrentLocation();
    const next = { lat: coords.lat, lng: coords.lng };
    setGeoCoords(next);
    return next;
  }, []);

  const setPreferredGeoCoords = useCallback((coords) => {
    if (
      coords &&
      typeof coords.lat === 'number' &&
      typeof coords.lng === 'number' &&
      Number.isFinite(coords.lat) &&
      Number.isFinite(coords.lng)
    ) {
      setGeoCoords({ lat: coords.lat, lng: coords.lng });
      return;
    }
    setGeoCoords(null);
  }, []);

  useEffect(() => {
    if (!prefs.location?.useLocation) {
      setGeoCoords(null);
      return;
    }
    requestGeoCoords().catch(() => {
      if (
        typeof userProfile?.latitude === 'number' &&
        typeof userProfile?.longitude === 'number'
      ) {
        setGeoCoords({ lat: userProfile.latitude, lng: userProfile.longitude });
      }
    });
  }, [prefs.location?.useLocation, requestGeoCoords, userProfile?.latitude, userProfile?.longitude]);

  const setTheme = useCallback((theme) => {
    if (theme !== 'dark' && theme !== 'light') return;
    setPrefsState((p) => ({ ...p, theme }));
  }, []);

  const toggleTheme = useCallback(() => {
    setPrefsState((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }));
  }, []);

  const setLanguage = useCallback((lang) => {
    setPrefsState((p) => ({ ...p, language: lang }));
  }, []);

  const setNotification = useCallback((path, value) => {
    setPrefsState((p) => {
      const next = { ...p, notifications: { ...p.notifications } };
      const parts = path.split('.');
      let obj = next.notifications;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        obj[key] = { ...obj[key] };
        obj = obj[key];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  }, []);

  const setLocation = useCallback((key, value) => {
    setPrefsState((p) => ({
      ...p,
      location: { ...p.location, [key]: value },
    }));
  }, []);

  const setFeedScope = useCallback((scope) => {
    setPrefsState((p) => ({ ...p, feedScope: normalizeFeedScope(scope) }));
  }, []);

  const setDisplayCurrency = useCallback((code) => {
    setPrefsState((p) => ({ ...p, displayCurrency: normalizeCurrency(code) }));
  }, []);

  const setPrivacySetting = useCallback((key, value) => {
    setPrivacyState((p) => ({ ...p, [key]: value }));
  }, []);

  const tKey = useCallback((key) => t(prefs.language, key), [prefs.language]);

  const value = {
    theme: prefs.theme,
    language: prefs.language,
    notifications: prefs.notifications,
    location: prefs.location,
    feedScope: prefs.feedScope,
    displayCurrency: prefs.displayCurrency,
    viewerCountryCode: userProfile?.country_code || null,
    viewerCity: userProfile?.city || null,
    privacy,
    geoCoords,
    requestGeoCoords,
    setPreferredGeoCoords,
    setTheme,
    toggleTheme,
    setLanguage,
    setNotification,
    setLocation,
    setFeedScope,
    setDisplayCurrency,
    setPrivacySetting,
    t: tKey,
    hydrated,
  };

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error('usePreferences must be used within PreferencesProvider');
  }
  return ctx;
}
