import React, { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import * as authService from '@/services/authService';
import { getRefreshToken, clearTokens } from '@/api/client';
import {
  readSessionCache,
  writeSessionCache,
  clearSessionCache,
  userFromSessionCache,
  isOnboardingMarkedComplete,
} from '@/lib/sessionCache';
import { setSessionResumeCallback, startSessionResume } from '@/lib/sessionResume';
import { shouldSkipAuthBootstrap } from '@/lib/publicAuthPaths';

const AuthContext = createContext();

export function hasStoredAuthTokens() {
  try {
    return Boolean(
      localStorage.getItem('access_token') ||
      sessionStorage.getItem('access_token') ||
      localStorage.getItem('refresh_token') ||
      sessionStorage.getItem('refresh_token'),
    );
  } catch {
    return false;
  }
}

function withTimeout(promise, ms, label = 'Request') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

function mapUser(currentUser) {
  return {
    id: currentUser.id,
    email: currentUser.email,
    full_name: currentUser.full_name,
    role: currentUser.role,
    verified: currentUser.verified,
    verification_status: currentUser.verification_status,
    identity_verified: currentUser.identity_verified,
    can_admin_dashboard: currentUser.can_admin_dashboard,
  };
}

function restoreCachedSession(setUser, setUserProfile, setIsAuthenticated) {
  const cached = readSessionCache();
  const restored = userFromSessionCache(cached);
  if (!restored.user) return false;
  setUser(restored.user);
  setUserProfile(restored.profile);
  setIsAuthenticated(true);
  return true;
}

/** Prefer a real profile from /me; never reuse another user's cached profile. */
function mergeProfileFromSession(prev, next, userId) {
  if (next != null) return next;
  const prevId = prev?.user_id || prev?.userId || prev?.id;
  if (prevId && userId && String(prevId) !== String(userId)) {
    return null;
  }
  if (
    prev?.onboarding_complete === true ||
    (userId && isOnboardingMarkedComplete(userId))
  ) {
    return prev?.onboarding_complete === true
      ? prev
      : { ...(prev || {}), onboarding_complete: true };
  }
  return next;
}

function profileForUserCache(profile, userId) {
  if (!profile) return null;
  const prevId = profile?.user_id || profile?.userId || profile?.id;
  if (prevId && userId && String(prevId) !== String(userId)) return null;
  return profile;
}

export const AuthProvider = ({ children }) => {
  const location = useLocation();
  const hasTokens = hasStoredAuthTokens();
  const initialCache = hasTokens ? readSessionCache() : null;
  const initialSession = userFromSessionCache(initialCache);
  const skipBootstrap = shouldSkipAuthBootstrap(location.pathname);

  const [user, setUser] = useState(initialSession.user);
  const [userProfile, setUserProfile] = useState(initialSession.profile);
  const [isAuthenticated, setIsAuthenticated] = useState(
    Boolean(initialSession.user) || hasTokens,
  );
  /** True only when we have tokens but no cached user to show yet (first open after login). */
  const [isLoadingAuth, setIsLoadingAuth] = useState(
    hasTokens && !initialSession.user && !skipBootstrap,
  );
  const [authError, setAuthError] = useState(null);
  // Holds the in-flight checkAuth promise so callers can await the same run.
  const checkInFlight = useRef(null);
  // Always revalidate once with tokens — even when a cached user exists (avoids stale onboarding flags).
  const hasBootstrapped = useRef(!hasTokens && !skipBootstrap);
  const hadCachedUserOnMount = useRef(Boolean(initialSession.user));
  const userRef = useRef(user);
  const userProfileRef = useRef(userProfile);
  userRef.current = user;
  userProfileRef.current = userProfile;

  const checkAuth = useCallback(async ({ soft = false } = {}) => {
    if (checkInFlight.current) return checkInFlight.current;

    const run = (async () => {
      const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
      const refreshToken = localStorage.getItem('refresh_token') || sessionStorage.getItem('refresh_token');

      if (!token && !refreshToken) {
        setUser(null);
        setUserProfile(null);
        setIsAuthenticated(false);
        setIsLoadingAuth(false);
        return;
      }

      // Soft revalidate (route change / resume): never blank the UI or force Login.
      const keepExistingUser = soft && Boolean(userRef.current);
      if (!keepExistingUser && !userRef.current) {
        setIsLoadingAuth(true);
      }

      // Screen recording / Control Center flickers visibility and retriggers resume.
      // If we already know onboarding is done, only apply successful non-null /me payloads.
      const alreadyOnboarded =
        soft &&
        Boolean(userRef.current?.id) &&
        (userProfileRef.current?.onboarding_complete === true ||
          isOnboardingMarkedComplete(userRef.current.id));
      if (alreadyOnboarded) {
        try {
          const { user: currentUser, userProfile: profile } = await withTimeout(
            authService.getAuthSession(),
            20000,
            'Session check',
          );
          if (profile != null) {
            const nextUser = mapUser(currentUser);
            setUser(nextUser);
            setIsAuthenticated(true);
            setUserProfile((prev) => mergeProfileFromSession(prev, profile, nextUser.id));
            writeSessionCache(currentUser, profile);
          }
          setAuthError(null);
        } catch {
          // Keep existing in-memory session — never wipe during capture/resume blips.
        } finally {
          setIsLoadingAuth(false);
        }
        return;
      }

      if (!token && refreshToken) {
        try {
          await withTimeout(authService.ensureSession(), 20000, 'Session refresh');
        } catch {
          // Offline or slow network — keep tokens and cached user; never force logout here.
        }
      }

      try {
        setAuthError(null);
        const { user: currentUser, userProfile: profile } = await withTimeout(
          authService.getAuthSession(),
          20000,
          'Session check',
        );
        const nextUser = mapUser(currentUser);
        setUser(nextUser);
        setIsAuthenticated(true);
        setUserProfile((prev) => mergeProfileFromSession(prev, profile, nextUser.id));
        writeSessionCache(
          currentUser,
          profile ?? profileForUserCache(userProfileRef.current, nextUser.id),
        );
      } catch (err) {
        const refreshStillValid = Boolean(getRefreshToken());
        if (refreshStillValid) {
          try {
            await withTimeout(authService.ensureSession(), 20000, 'Session refresh retry');
            const { user: retryUser, userProfile: retryProfile } = await withTimeout(
              authService.getAuthSession(),
              20000,
              'Session check retry',
            );
            const nextUser = mapUser(retryUser);
            setUser(nextUser);
            setIsAuthenticated(true);
            setUserProfile((prev) => mergeProfileFromSession(prev, retryProfile, nextUser.id));
            writeSessionCache(
              retryUser,
              retryProfile ?? profileForUserCache(userProfileRef.current, nextUser.id),
            );
            setAuthError(null);
            return;
          } catch {
            // fall through to cached session handling
          }
        }

        const hadCachedUser = restoreCachedSession(setUser, setUserProfile, setIsAuthenticated);

        // Never treat as auth_required while a refresh token still exists.
        if ((err?.status === 401 || err?.status === 403) && !refreshStillValid && !hadCachedUser) {
          clearTokens();
          clearSessionCache();
          setUser(null);
          setUserProfile(null);
          setIsAuthenticated(false);
          setAuthError({ type: 'auth_required', message: 'Please sign in' });
        } else if (hadCachedUser || refreshStillValid || keepExistingUser) {
          setAuthError(null);
          if (refreshStillValid) setIsAuthenticated(true);
        } else {
          setAuthError({ type: 'unknown', message: err?.message || 'Auth check failed' });
        }
      } finally {
        setIsLoadingAuth(false);
      }
    })();

    checkInFlight.current = run;
    try {
      await run;
    } finally {
      if (checkInFlight.current === run) checkInFlight.current = null;
    }
  }, []);

  useEffect(() => {
    if (shouldSkipAuthBootstrap(location.pathname)) {
      setIsLoadingAuth(false);
      return;
    }
    if (!hasTokens) {
      setIsLoadingAuth(false);
      return;
    }
    // First bootstrap only on mount / token appearance — not on every route change.
    // Soft when we already painted a cached user so Profile/Home don't blank.
    if (!hasBootstrapped.current) {
      hasBootstrapped.current = true;
      void checkAuth({ soft: hadCachedUserOnMount.current });
    }
  }, [checkAuth, hasTokens, location.pathname]);

  useEffect(() => {
    setSessionResumeCallback(() => {
      if (shouldSkipAuthBootstrap(window.location.pathname)) return;
      void checkAuth({ soft: true });
    });
    return startSessionResume();
  }, [checkAuth]);

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setUserProfile(null);
    setIsAuthenticated(false);
    clearSessionCache();
    authService.logout(shouldRedirect);
  };

  const navigateToLogin = () => {
    // Only hard-navigate when refresh is truly gone.
    if (getRefreshToken()) {
      setAuthError(null);
      void checkAuth({ soft: true });
      return;
    }
    authService.redirectToLogin(window.location.href, { clearSession: false, force: true });
  };

  const isRestoringSession = hasStoredAuthTokens() && !user && isLoadingAuth;

  return (
    <AuthContext.Provider
      value={{
        user,
        userProfile,
        isAuthenticated,
        isLoadingAuth,
        isRestoringSession,
        isLoadingPublicSettings: isLoadingAuth,
        authError,
        appPublicSettings: null,
        logout,
        navigateToLogin,
        checkAppState: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
