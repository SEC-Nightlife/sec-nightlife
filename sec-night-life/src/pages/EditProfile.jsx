import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { integrations } from '@/services/integrationService';
import { apiGet, apiPatch } from '@/api/client';
import { ChevronLeft, Camera, User, Wine, BadgeCheck, Loader2, Check, X, Calendar, LocateFixed, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import AvatarCropDialog from '@/components/profile/AvatarCropDialog';
import GoogleAddressInput from '@/components/GoogleAddressInput';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import CountryCityPicker from '@/components/location/CountryCityPicker';
import { DEFAULT_COUNTRY_CODE, guessCountryFromBrowser, normalizeCountryCode } from '@/lib/countries';

const DRINKS = [
  'Whiskey', 'Vodka', 'Gin', 'Tequila', 'Rum', 'Champagne',
  'Wine', 'Beer', 'Cocktails', 'Non-alcoholic',
];
const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
];

export default function EditProfile() {
  const navigate = useNavigate();
  const [userProfile, setUserProfile] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [usernameCheck, setUsernameCheck] = useState(null);

  const [formData, setFormData] = useState({
    full_name: '',
    username: '',
    bio: '',
    city: '',
    country_code: '',
    region: '',
    favorite_drink: '',
    gender: '',
    avatar_url: '',
    date_of_birth: '',
    latitude: null,
    longitude: null,
    location_label: '',
  });
  const [locating, setLocating] = useState(false);
  const [ageDeclarationAccepted, setAgeDeclarationAccepted] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState(null);

  const normalizedUsername = useMemo(
    () => formData.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
    [formData.username]
  );

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (normalizedUsername.length < 3) {
      setUsernameCheck(normalizedUsername.length === 0 ? null : 'invalid');
      return;
    }
    setUsernameCheck('loading');
    const t = setTimeout(async () => {
      try {
        const res = await apiGet(`/api/users/check-username/${encodeURIComponent(normalizedUsername)}`);
        setUsernameCheck(res.available ? 'ok' : 'taken');
      } catch {
        setUsernameCheck(null);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [normalizedUsername]);

  const usernameBlocking =
    !normalizedUsername || normalizedUsername.length < 3 || usernameCheck !== 'ok';

  const loadData = async () => {
    try {
      const rows = await apiGet('/api/users/profile');
      const profile = Array.isArray(rows) ? rows[0] : rows;
      if (!profile) {
        toast.error('Profile not found');
        authService.redirectToLogin();
        return;
      }
      setUserProfile(profile);
      const u = (profile.username || '').toString().replace(/^@/, '');
      setFormData({
        full_name: profile.full_name || '',
        username: u,
        bio: profile.bio || '',
        city: profile.city || '',
        country_code:
          normalizeCountryCode(profile.country_code) || guessCountryFromBrowser() || DEFAULT_COUNTRY_CODE,
        region: profile.region || '',
        favorite_drink: profile.favorite_drink || '',
        gender: profile.gender || '',
        avatar_url: profile.avatar_url || '',
        date_of_birth: profile.date_of_birth || '',
        latitude: profile.latitude ?? null,
        longitude: profile.longitude ?? null,
        location_label: profile.location_label || '',
      });
      if (profile.age_verified || profile.verification_status === 'verified' || profile.verification_status === 'approved') {
        setAgeDeclarationAccepted(true);
      }
    } catch {
      try {
        await authService.loadUserOrLogin();
      } catch {
        // loadUserOrLogin redirects when no session remains
      }
    } finally {
      setIsLoading(false);
    }
  };

  const onPickAvatarImage = (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      if (file) toast.error('Please choose an image file');
      return;
    }
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(URL.createObjectURL(file));
    setCropOpen(true);
    e.target.value = '';
  };

  const handleCroppedAvatar = async (file) => {
    try {
      const { file_url } = await integrations.Core.UploadFile({ file });
      setFormData((prev) => ({ ...prev, avatar_url: file_url }));
      toast.success('Photo ready — save to apply');
    } catch {
      toast.error('Failed to upload image');
    }
  };

  const isAtLeast18 = (dob) => {
    if (!dob) return false;
    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDelta = today.getMonth() - birth.getMonth();
    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) age -= 1;
    return age >= 18;
  };

  const handleSave = async () => {
    if (usernameBlocking) {
      toast.error('Choose an available username (3–30 characters, letters, numbers, underscores)');
      return;
    }
    setIsSaving(true);
    try {
      const alreadyVerified =
        userProfile?.verification_status === 'verified' || userProfile?.verification_status === 'approved';
      const fillingAgeBlock = !alreadyVerified && (Boolean(formData.date_of_birth) || ageDeclarationAccepted);
      if (fillingAgeBlock) {
        if (!formData.date_of_birth || !formData.gender) {
          toast.error('Date of birth and gender are required for age verification.');
          setIsSaving(false);
          return;
        }
        if (!isAtLeast18(formData.date_of_birth)) {
          toast.error('You must be at least 18 years old.');
          setIsSaving(false);
          return;
        }
        if (!ageDeclarationAccepted) {
          toast.error('Accept the Age Verification Declaration to continue.');
          setIsSaving(false);
          return;
        }
        await dataService.Legal.acceptDocument({
          document_key: 'age_verification_declaration',
          version: '1.0',
        });
      }

      const resolvedCity = (formData.city || '').trim();
      const payload = {
        full_name: formData.full_name.trim(),
        username: normalizedUsername,
        bio: formData.bio,
        city: resolvedCity || null,
        country_code: formData.country_code || null,
        region: formData.region || null,
        favorite_drink: formData.favorite_drink || null,
        gender: formData.gender || null,
        avatar_url: formData.avatar_url || null,
        date_of_birth: formData.date_of_birth || null,
        latitude: formData.latitude,
        longitude: formData.longitude,
        location_label: formData.location_label || null,
      };
      const updated = await apiPatch('/api/users/profile', payload);
      setUserProfile((prev) => (prev ? { ...prev, ...updated } : prev));
      toast.success('Profile updated');
      navigate(createPageUrl('Profile'));
    } catch (err) {
      const msg = err?.data?.error || err?.message || 'Failed to update profile';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  const labelStyle = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 600, letterSpacing: '0.09em',
    textTransform: 'uppercase', color: 'var(--sec-text-muted)',
    marginBottom: 8,
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)', paddingBottom: 40 }}>

      <header style={{
        position: 'sticky', top: 0, zIndex: 40,
        backgroundColor: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--sec-border)',
        padding: '0 20px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={() => navigate(-1)}
            style={{
              width: 36, height: 36, borderRadius: '50%',
              backgroundColor: 'var(--sec-bg-card)',
              border: '1px solid var(--sec-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--sec-text-secondary)',
            }}
          >
            <ChevronLeft size={18} strokeWidth={2} />
          </button>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: 'var(--sec-text-primary)', letterSpacing: '-0.01em' }}>
            Edit Profile
          </h1>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || usernameBlocking}
          className="sec-btn sec-btn-primary"
          style={{ padding: '8px 20px', fontSize: 13 }}
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '32px 20px', display: 'flex', flexDirection: 'column', gap: 24 }}>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <label style={{ cursor: 'pointer' }}>
            <div style={{ position: 'relative' }}>
              <div style={{
                width: 96, height: 96, borderRadius: '50%',
                border: '1px solid var(--sec-border-strong)',
                backgroundColor: 'var(--sec-bg-elevated)',
                overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {formData.avatar_url ? (
                  <img src={formData.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <User size={36} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                )}
              </div>

              <div style={{
                position: 'absolute', bottom: 0, right: 0,
                width: 30, height: 30, borderRadius: '50%',
                backgroundColor: 'var(--sec-bg-card)',
                border: '1px solid var(--sec-border-strong)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Camera size={14} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
              </div>
            </div>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickAvatarImage} />
          </label>
        </div>

        <AvatarCropDialog
          open={cropOpen}
          onOpenChange={(o) => {
            setCropOpen(o);
            if (!o && cropSrc) {
              URL.revokeObjectURL(cropSrc);
              setCropSrc(null);
            }
          }}
          imageSrc={cropSrc}
          onCropped={handleCroppedAvatar}
        />

        {userProfile?.is_verified_promoter && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px', borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--sec-accent-muted)',
            border: '1px solid var(--sec-accent-border)',
          }}>
            <BadgeCheck size={16} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-accent)' }}>
              Verified Promoter
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          <div>
            <div style={labelStyle}>
              <User size={12} strokeWidth={2} />
              Full name
            </div>
            <Input
              value={formData.full_name}
              onChange={(e) => setFormData((prev) => ({ ...prev, full_name: e.target.value }))}
              placeholder="Your display name"
              style={{
                height: 46,
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--sec-text-primary)',
                fontSize: 14,
                paddingLeft: 14,
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>
              Others can search for you by this name. Duplicates are allowed.
            </p>
          </div>

          <div>
            <div style={labelStyle}>
              <User size={12} strokeWidth={2} />
              Username
            </div>
            <Input
              value={formData.username}
              onChange={(e) => setFormData((prev) => ({
                ...prev,
                username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
              }))}
              placeholder="Unique handle"
              autoComplete="username"
              style={{
                height: 46,
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--sec-text-primary)',
                fontSize: 14,
                paddingLeft: 14,
              }}
            />
            {formData.username ? (
              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>
                @{formData.username}
              </p>
            ) : null}
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, minHeight: 22 }}>
              {usernameCheck === 'loading' && (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--sec-text-muted)' }} />
                  <span style={{ color: 'var(--sec-text-muted)' }}>Checking…</span>
                </>
              )}
              {usernameCheck === 'ok' && (
                <>
                  <Check size={16} style={{ color: 'var(--sec-accent, #22c55e)' }} />
                  <span style={{ color: 'var(--sec-accent, #22c55e)' }}>Username available</span>
                </>
              )}
              {usernameCheck === 'taken' && (
                <>
                  <X size={16} style={{ color: '#ef4444' }} />
                  <span style={{ color: '#ef4444' }}>Username already taken</span>
                </>
              )}
              {usernameCheck === 'invalid' && (
                <span style={{ color: '#f59e0b' }}>3–30 characters, letters, numbers, underscores only</span>
              )}
            </div>
          </div>

          <div>
            <div style={labelStyle}>
              <FileText size={12} strokeWidth={2} />
              Bio
            </div>
            <Textarea
              value={formData.bio}
              onChange={(e) => setFormData((prev) => ({ ...prev, bio: e.target.value }))}
              placeholder="Tell people about yourself…"
              rows={4}
              style={{
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--sec-text-primary)',
                fontSize: 14,
                padding: '12px 14px',
                resize: 'none',
              }}
            />
          </div>

          <CountryCityPicker
            value={{
              countryCode: formData.country_code,
              city: formData.city,
              region: formData.region,
            }}
            showRegion
            onChange={(next) => {
              setFormData((prev) => ({
                ...prev,
                country_code: next.countryCode || '',
                city: next.city || '',
                region: next.region || '',
              }));
            }}
          />

          <div>
            <div style={labelStyle}>
              <LocateFixed size={12} strokeWidth={2} />
              Preferred location
            </div>
            <button
              type="button"
              onClick={async () => {
                setLocating(true);
                try {
                  const { getCurrentLocation, locationErrorMessage } = await import(
                    '@/lib/getCurrentLocation'
                  );
                  const { lat, lng } = await getCurrentLocation();
                  setFormData((prev) => ({
                    ...prev,
                    latitude: lat,
                    longitude: lng,
                    location_label: prev.location_label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
                  }));
                  try {
                    const { reverseGeocodeLatLngStructured } = await import('@/lib/reverseGeocode');
                    const structured = await reverseGeocodeLatLngStructured(lat, lng);
                    setFormData((prev) => ({
                      ...prev,
                      latitude: lat,
                      longitude: lng,
                      location_label:
                        structured?.formattedAddress || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
                      suburb: structured?.suburb || prev.suburb || '',
                      province: structured?.province || prev.province || '',
                    }));
                    toast.success(
                      structured?.formattedAddress
                        ? 'Location updated'
                        : 'Saved GPS coordinates — refine the address if needed',
                    );
                  } catch {
                    toast.success('Location updated');
                  }
                } catch (err) {
                  const { locationErrorMessage } = await import('@/lib/getCurrentLocation');
                  toast.error(locationErrorMessage(err));
                } finally {
                  setLocating(false);
                }
              }}
              disabled={locating}
              style={{
                width: '100%',
                height: 44,
                marginBottom: 10,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--sec-border)',
                backgroundColor: 'var(--sec-bg-card)',
                color: 'var(--sec-text-primary)',
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: locating ? 'wait' : 'pointer',
              }}
            >
              {locating ? <Loader2 size={16} className="animate-spin" /> : <LocateFixed size={16} />}
              {locating ? 'Getting location…' : 'Use my current location'}
            </button>
            <GoogleAddressInput
              label="Or enter a place"
              placeholder="Suburb, street, or landmark"
              countryCode={formData.country_code}
              value={
                formData.location_label
                  ? {
                      formattedAddress: formData.location_label,
                      latitude: formData.latitude,
                      longitude: formData.longitude,
                    }
                  : null
              }
              onChange={(addr) => {
                setFormData((prev) => ({
                  ...prev,
                  location_label: addr?.formattedAddress || '',
                  latitude: addr?.latitude ?? null,
                  longitude: addr?.longitude ?? null,
                }));
              }}
            />
          </div>

          <div>
            <div style={labelStyle}>
              <User size={12} strokeWidth={2} />
              Gender
            </div>
            <Select value={formData.gender || undefined} onValueChange={(v) => setFormData((prev) => ({ ...prev, gender: v }))}>
              <SelectTrigger style={{
                height: 46,
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: formData.gender ? 'var(--sec-text-primary)' : 'var(--sec-text-muted)',
                fontSize: 14,
              }}>
                <SelectValue placeholder="Select your gender" />
              </SelectTrigger>
              <SelectContent style={{
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-lg)',
              }}>
                {GENDER_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    style={{ color: 'var(--sec-text-primary)', cursor: 'pointer' }}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div style={labelStyle}>
              <Wine size={12} strokeWidth={2} />
              Favourite Drink
            </div>
            <Select value={formData.favorite_drink || undefined} onValueChange={(v) => setFormData((prev) => ({ ...prev, favorite_drink: v }))}>
              <SelectTrigger style={{
                height: 46,
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: formData.favorite_drink ? 'var(--sec-text-primary)' : 'var(--sec-text-muted)',
                fontSize: 14,
              }}>
                <SelectValue placeholder="What's your go-to?" />
              </SelectTrigger>
              <SelectContent style={{
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-lg)',
              }}>
                {DRINKS.map((drink) => (
                  <SelectItem
                    key={drink}
                    value={drink}
                    style={{ color: 'var(--sec-text-primary)', cursor: 'pointer' }}
                  >
                    {drink}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            style={{
              padding: 16,
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--sec-border)',
              backgroundColor: 'var(--sec-bg-card)',
            }}
          >
            <div style={{ ...labelStyle, marginBottom: 12 }}>
              <BadgeCheck size={12} strokeWidth={2} />
              Age verification
            </div>
            <p style={{ fontSize: 13, color: 'var(--sec-text-secondary)', marginBottom: 12 }}>
              Status:{' '}
              <strong style={{ color: 'var(--sec-text-primary)' }}>
                {userProfile?.verification_status === 'verified' || userProfile?.verification_status === 'approved'
                  ? 'Age verified'
                  : userProfile?.verification_status === 'submitted'
                    ? 'Legacy ID pending review'
                    : userProfile?.verification_status === 'rejected'
                      ? 'Rejected'
                      : 'Not verified'}
              </strong>
            </p>
            {userProfile?.verification_rejection_note && userProfile?.verification_status === 'rejected' ? (
              <p style={{ fontSize: 12, color: '#f87171', marginBottom: 12 }}>
                {userProfile.verification_rejection_note}
              </p>
            ) : null}
            {userProfile?.verification_status !== 'verified' && userProfile?.verification_status !== 'approved' ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={labelStyle}>
                    <Calendar size={12} strokeWidth={2} /> Date of birth
                  </div>
                  <Input
                    type="date"
                    value={formData.date_of_birth}
                    onChange={(e) => setFormData((prev) => ({ ...prev, date_of_birth: e.target.value }))}
                    style={{
                      height: 46,
                      backgroundColor: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--sec-text-primary)',
                      fontSize: 14,
                      paddingLeft: 14,
                    }}
                  />
                </div>
                <label className="flex items-start gap-3 cursor-pointer" style={{ marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ageDeclarationAccepted}
                    onChange={(e) => setAgeDeclarationAccepted(e.target.checked)}
                  />
                  <span style={{ fontSize: 13, color: 'var(--sec-text-secondary)', lineHeight: 1.5 }}>
                    I confirm I am 18 or older and accept the{' '}
                    <Link to={createPageUrl('AgeVerificationDeclaration')} style={{ color: 'var(--sec-accent)' }}>
                      Age Verification Declaration
                    </Link>
                    .
                  </span>
                </label>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>
                  Save to complete age verification automatically.
                </p>
              </>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>
                Your age is verified. Update date of birth or gender only if your details have changed.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || usernameBlocking}
          className="sec-btn sec-btn-primary sec-btn-full"
          style={{ marginTop: 8, fontSize: 15 }}
        >
          {isSaving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
