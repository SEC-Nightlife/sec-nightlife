import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  Globe,
  Bell,
  MapPin,
  Ruler,
  Shield,
  LocateFixed,
  Loader2,
  Compass,
  Coins,
} from 'lucide-react';
import { createPageUrl } from '@/utils';
import { usePreferences } from '@/context/PreferencesContext';
import { useAuth } from '@/lib/AuthContext';
import { Switch } from '@/components/ui/switch';
import PageBackHeader from '@/components/layout/PageBackHeader';
import GoogleAddressInput from '@/components/GoogleAddressInput';
import { apiPatch } from '@/api/client';
import { toast } from 'sonner';
import FeedScopeToggle from '@/components/location/FeedScopeToggle';
import { allCountryCurrencies, currencyForCountry } from '@/lib/countries';
import { listCurrencies } from '@/lib/money';

function SectionCard({ title, children }) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}
    >
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--sec-border)' }}>
        <p className="text-sm font-semibold" style={{ color: 'var(--sec-text-muted)' }}>
          {title}
        </p>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ icon: Icon, label, description, children }) {
  return (
    <div
      className="flex items-center gap-4 p-4"
      style={{ borderBottom: '1px solid var(--sec-border)' }}
    >
      {Icon && <Icon className="w-5 h-5 shrink-0" style={{ color: 'var(--sec-text-muted)' }} />}
      <div className="flex-1 min-w-0">
        <p className="font-medium" style={{ color: 'var(--sec-text-primary)' }}>
          {label}
        </p>
        {description && (
          <p className="text-sm mt-0.5" style={{ color: 'var(--sec-text-muted)' }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function placeFromProfile(profile) {
  if (!profile) {
    return {
      formattedAddress: '',
      latitude: null,
      longitude: null,
      suburb: '',
      province: '',
    };
  }
  const lat = typeof profile.latitude === 'number' ? profile.latitude : null;
  const lng = typeof profile.longitude === 'number' ? profile.longitude : null;
  return {
    formattedAddress: profile.location_label || '',
    latitude: lat,
    longitude: lng,
    suburb: '',
    province: '',
  };
}

export default function AppPreferences() {
  const {
    language,
    t,
    notifications: notif,
    setNotification,
    setLocation,
    location: loc,
    requestGeoCoords,
    setPreferredGeoCoords,
    geoCoords,
    displayCurrency,
    setDisplayCurrency,
    viewerCountryCode,
  } = usePreferences();
  const countryCurrency = currencyForCountry(viewerCountryCode);
  const currencyOptions = React.useMemo(() => listCurrencies(allCountryCurrencies()), []);
  const { userProfile, checkAppState } = useAuth();
  const [locating, setLocating] = useState(false);
  const [placeDraft, setPlaceDraft] = useState(() => placeFromProfile(userProfile));
  const userEditedPlaceRef = useRef(false);

  useEffect(() => {
    if (!userProfile || userEditedPlaceRef.current) return;
    const next = placeFromProfile(userProfile);
    if (next.latitude == null && next.longitude == null && !next.formattedAddress) return;
    setPlaceDraft(next);
    if (next.latitude != null && next.longitude != null) {
      setPreferredGeoCoords({ lat: next.latitude, lng: next.longitude });
    }
  }, [
    userProfile?.latitude,
    userProfile?.longitude,
    userProfile?.location_label,
    setPreferredGeoCoords,
  ]);

  const radiusKm = Number(loc?.radiusKm) || 25;
  const radiusDisplay = loc?.distanceUnit === 'mi' ? Math.round(radiusKm * 0.621371) : radiusKm;
  const radiusUnit = loc?.distanceUnit === 'mi' ? 'mi' : 'km';

  const savePreferredCoords = async ({ lat, lng, label, suburb, province }) => {
    await apiPatch('/api/users/profile', {
      latitude: lat,
      longitude: lng,
      location_label: label || null,
    });
    setPreferredGeoCoords({ lat, lng });
    setPlaceDraft({
      formattedAddress: label || '',
      latitude: lat,
      longitude: lng,
      suburb: suburb || '',
      province: province || '',
    });
    setLocation('useLocation', true);
    try {
      await checkAppState?.({ soft: true });
    } catch {
      /* ignore */
    }
  };

  const onLocationToggle = async (enabled) => {
    setLocation('useLocation', enabled);
    if (enabled) {
      try {
        if (
          typeof userProfile?.latitude === 'number' &&
          typeof userProfile?.longitude === 'number'
        ) {
          setPreferredGeoCoords({ lat: userProfile.latitude, lng: userProfile.longitude });
        } else {
          await requestGeoCoords();
        }
      } catch (err) {
        const { locationErrorMessage } = await import('@/lib/getCurrentLocation');
        toast.error(locationErrorMessage(err));
      }
    }
  };

  const useLiveLocation = async () => {
    setLocating(true);
    try {
      const coords = await requestGeoCoords();
      let label = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
      let suburb = '';
      let province = '';
      try {
        const { reverseGeocodeLatLngStructured } = await import('@/lib/reverseGeocode');
        const structured = await reverseGeocodeLatLngStructured(coords.lat, coords.lng);
        label = structured?.formattedAddress || label;
        suburb = structured?.suburb || '';
        province = structured?.province || '';
      } catch {
        /* keep coordinate fallback */
      }
      userEditedPlaceRef.current = true;
      await savePreferredCoords({
        lat: coords.lat,
        lng: coords.lng,
        label,
        suburb,
        province,
      });
      toast.success('Live location saved for nearby discovery');
    } catch (err) {
      const { locationErrorMessage } = await import('@/lib/getCurrentLocation');
      toast.error(locationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  const onPlaceChange = async (addr) => {
    userEditedPlaceRef.current = true;
    setPlaceDraft({
      formattedAddress: addr?.formattedAddress || '',
      latitude: addr?.latitude ?? null,
      longitude: addr?.longitude ?? null,
      suburb: addr?.suburb || '',
      province: addr?.province || '',
    });
    if (addr?.latitude == null || addr?.longitude == null) return;
    try {
      await savePreferredCoords({
        lat: addr.latitude,
        lng: addr.longitude,
        label: addr.formattedAddress || '',
        suburb: addr.suburb,
        province: addr.province,
      });
      toast.success('Preferred location updated');
    } catch {
      toast.error('Could not save preferred location');
    }
  };

  const activeLabel =
    placeDraft.formattedAddress ||
    userProfile?.location_label ||
    (geoCoords ? `${geoCoords.lat.toFixed(4)}, ${geoCoords.lng.toFixed(4)}` : null);

  const hasSavedPlace =
    Boolean(placeDraft.formattedAddress) ||
    (placeDraft.latitude != null && placeDraft.longitude != null);

  return (
    <div className="min-h-screen pb-8" style={{ backgroundColor: 'var(--sec-bg-base)', color: 'var(--sec-text-primary)' }}>
      <PageBackHeader title={t('appPreferences')} fallbackTo="Settings" pageName="AppPreferences" />

      <div className="px-4 py-6 max-w-xl mx-auto space-y-6">
        <SectionCard title={t('language')}>
          <SettingRow
            icon={Globe}
            label={t('language')}
            description={language === 'en' ? 'English' : language}
          >
            <span className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
              English
            </span>
          </SettingRow>
        </SectionCard>

        <SectionCard title="What you see">
          <div className="p-4 space-y-3" style={{ borderBottom: '1px solid var(--sec-border)' }}>
            <div className="flex items-start gap-4">
              <Compass className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--sec-text-muted)' }} />
              <div className="flex-1 min-w-0">
                <p className="font-medium" style={{ color: 'var(--sec-text-primary)' }}>
                  Show events, tables and venues from
                </p>
                <p className="text-sm mt-0.5" style={{ color: 'var(--sec-text-muted)' }}>
                  Near me uses your location (or your city). You can also browse your whole country or the world.
                </p>
              </div>
            </div>
            <FeedScopeToggle />
          </div>
          <SettingRow
            icon={Coins}
            label="Display currency"
            description="Prices are converted for display only (approximate). Payments are charged in South African rand (ZAR)."
          >
            <select
              aria-label="Display currency"
              value={displayCurrency || ''}
              onChange={(e) => setDisplayCurrency(e.target.value || null)}
              className="sec-input-rect"
              style={{ height: 38, maxWidth: 170, paddingTop: 0, paddingBottom: 0, fontSize: 13 }}
            >
              <option value="">Auto ({countryCurrency})</option>
              {currencyOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </SettingRow>
        </SectionCard>

        <SectionCard title={t('notifications')}>
          <SettingRow
            icon={Bell}
            label={t('enableNotifications')}
            description={t('managePushNotifications')}
          >
            <Switch
              checked={notif?.enabled ?? true}
              onCheckedChange={(v) => setNotification('enabled', v)}
            />
          </SettingRow>
          <div className="pl-4 pr-4 pb-3" style={{ borderBottom: '1px solid var(--sec-border)' }}>
            <p className="text-xs font-medium mb-2 pt-2" style={{ color: 'var(--sec-text-muted)' }}>
              {t('pushNotifications')}
            </p>
            {[
              { key: 'eventReminders', label: t('eventReminders') },
              { key: 'tableInvitations', label: t('tableInvitations') },
              { key: 'friendRequests', label: t('friendRequests') },
              { key: 'messages', label: t('messages') },
              { key: 'promotions', label: t('promotionsFromVenues') },
              { key: 'appUpdates', label: t('appUpdates') },
            ].map(({ key, label }) => (
              <div
                key={key}
                className="flex items-center justify-between py-2"
                style={{ opacity: notif?.enabled ? 1 : 0.5 }}
              >
                <span className="text-sm" style={{ color: 'var(--sec-text-secondary)' }}>
                  {label}
                </span>
                <Switch
                  checked={notif?.push?.[key] ?? true}
                  onCheckedChange={(v) => setNotification(`push.${key}`, v)}
                  disabled={!notif?.enabled}
                />
              </div>
            ))}
          </div>
          <div className="pl-4 pr-4 py-3">
            <p className="text-xs font-medium mb-2" style={{ color: 'var(--sec-text-muted)' }}>
              {t('emailNotifications')}
            </p>
            {[
              { key: 'eventReminders', label: t('emailEventReminders') },
              { key: 'promotions', label: t('emailPromotions') },
            ].map(({ key, label }) => (
              <div
                key={key}
                className="flex items-center justify-between py-2"
                style={{ opacity: notif?.enabled ? 1 : 0.5 }}
              >
                <span className="text-sm" style={{ color: 'var(--sec-text-secondary)' }}>
                  {label}
                </span>
                <Switch
                  checked={notif?.email?.[key] ?? true}
                  onCheckedChange={(v) => setNotification(`email.${key}`, v)}
                  disabled={!notif?.enabled}
                />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title={t('locationSettings')}>
          <SettingRow
            icon={MapPin}
            label={t('useLocationForVenues')}
            description={t('useLocationForVenuesDesc')}
          >
            <Switch
              checked={loc?.useLocation ?? false}
              onCheckedChange={(v) => void onLocationToggle(v)}
            />
          </SettingRow>

          <div className="px-4 py-4 space-y-3" style={{ borderBottom: '1px solid var(--sec-border)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--sec-text-primary)' }}>
              Preferred location
            </p>
            <p className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>
              {hasSavedPlace
                ? 'Saved from your profile (including onboarding). Update anytime with live GPS or a place search.'
                : 'Set your live GPS or a place you choose so Home and Map can filter venues and events near you.'}
            </p>
            <button
              type="button"
              onClick={() => void useLiveLocation()}
              disabled={locating}
              className="w-full h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
              style={{
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid rgba(192, 192, 192, 0.25)',
                color: 'var(--sec-text-primary)',
              }}
            >
              {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LocateFixed className="w-4 h-4" />}
              {locating ? 'Getting location…' : hasSavedPlace ? 'Update with my current location' : 'Use my current location'}
            </button>
            <GoogleAddressInput
              label="Or enter a place"
              placeholder="Suburb, street, or landmark"
              showSuburbProvince
              value={hasSavedPlace ? placeDraft : null}
              onChange={(addr) => void onPlaceChange(addr)}
            />
            {activeLabel ? (
              <p className="text-xs" style={{ color: 'var(--sec-accent)' }}>
                Active: {activeLabel}
              </p>
            ) : null}
          </div>

          {loc?.useLocation ? (
            <div className="px-4 pb-4" style={{ borderBottom: '1px solid var(--sec-border)' }}>
              <div className="flex items-center justify-between mb-2 pt-3">
                <span className="text-sm" style={{ color: 'var(--sec-text-secondary)' }}>
                  Nearby radius
                </span>
                <span className="text-sm font-semibold" style={{ color: 'var(--sec-accent)' }}>
                  {radiusDisplay} {radiusUnit}
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={radiusKm}
                onChange={(e) => setLocation('radiusKm', Number(e.target.value))}
                className="w-full accent-[var(--sec-accent)]"
              />
              <p className="text-xs mt-1" style={{ color: 'var(--sec-text-muted)' }}>
                Home and Map show venues and events within this distance when location is on.
              </p>
            </div>
          ) : null}
          <SettingRow
            icon={Ruler}
            label={t('distanceUnit')}
            description={loc?.distanceUnit === 'mi' ? t('miles') : t('kilometers')}
          >
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLocation('distanceUnit', 'km')}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: loc?.distanceUnit === 'km' ? 'var(--sec-accent-muted)' : 'transparent',
                  color: loc?.distanceUnit === 'km' ? 'var(--sec-accent)' : 'var(--sec-text-muted)',
                  border: '1px solid var(--sec-border)',
                }}
              >
                km
              </button>
              <button
                type="button"
                onClick={() => setLocation('distanceUnit', 'mi')}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: loc?.distanceUnit === 'mi' ? 'var(--sec-accent-muted)' : 'transparent',
                  color: loc?.distanceUnit === 'mi' ? 'var(--sec-accent)' : 'var(--sec-text-muted)',
                  border: '1px solid var(--sec-border)',
                }}
              >
                mi
              </button>
            </div>
          </SettingRow>
        </SectionCard>

        <Link
          to={createPageUrl('Privacy')}
          className="flex items-center gap-4 p-4 rounded-2xl transition-colors"
          style={{ backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}
        >
          <Shield className="w-5 h-5 shrink-0" style={{ color: 'var(--sec-text-muted)' }} />
          <div className="flex-1">
            <p className="font-medium" style={{ color: 'var(--sec-text-primary)' }}>
              {t('privacySecurity')}
            </p>
            <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
              Manage privacy and visibility settings
            </p>
          </div>
          <ChevronRight className="w-5 h-5" style={{ color: 'var(--sec-text-muted)' }} />
        </Link>
      </div>
    </div>
  );
}
