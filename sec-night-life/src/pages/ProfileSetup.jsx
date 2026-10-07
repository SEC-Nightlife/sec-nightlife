import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { integrations } from '@/services/integrationService';
import { apiPost } from '@/api/client';
import {
  User,
  MapPin,
  Calendar,
  CreditCard,
  ChevronLeft,
  ChevronRight,
  Check,
  Upload,
  Camera,
  Lock,
  FileText,
  Wine,
  X,
  Store,
  LocateFixed,
  Loader2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { motion, AnimatePresence } from 'framer-motion';
import SecLogo from '@/components/ui/SecLogo';
import AvatarCropDialog from '@/components/profile/AvatarCropDialog';
import OnboardingStepIndicator from '@/components/onboarding/OnboardingStepIndicator';
import { markOnboardingComplete } from '@/lib/sessionCache';
import GoogleAddressInput from '@/components/GoogleAddressInput';
import VendorListingForm, { isVendorListingValid } from '@/components/vendors/VendorListingForm';
import PayoutTrustBanner from '@/components/wallet/PayoutTrustBanner';
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

function profileSetupDraftKey(userId) {
  return `sec-profile-setup-draft:${userId}`;
}

function loadProfileSetupDraft(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(profileSetupDraftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearProfileSetupDraft(userId) {
  if (!userId) return;
  try {
    localStorage.removeItem(profileSetupDraftKey(userId));
  } catch {
    /* ignore */
  }
}

export default function ProfileSetup() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEditMode = searchParams.get('edit') === '1';
  const stepFromUrl = Number(searchParams.get('step'));
  const [step, setStep] = useState(() =>
    Number.isFinite(stepFromUrl) && stepFromUrl >= 1 && stepFromUrl <= 5 ? stepFromUrl : 1
  );
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState({});
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState(null);
  const [locating, setLocating] = useState(false);
  const [hasVendorBusiness, setHasVendorBusiness] = useState(null); // null | true | false
  const [vendorDraft, setVendorDraft] = useState({
    name: '',
    category: '',
    description: '',
    website: '',
    images: [],
  });
  const [draftReady, setDraftReady] = useState(false);

  const [formData, setFormData] = useState({
    username: '',
    bio: '',
    avatar_url: '',
    city: '',
    country_code: guessCountryFromBrowser() || DEFAULT_COUNTRY_CODE,
    region: '',
    favorite_drink: '',
    gender: '',
    date_of_birth: '',
    latitude: null,
    longitude: null,
    location_label: '',
    suburb: '',
    province: '',
    payout_account_name: '',
    payout_account_number: '',
    payout_bank_code: '',
  });
  const [ageDeclarationAccepted, setAgeDeclarationAccepted] = useState(false);

  const steps = [
    { number: 1, title: 'Basics', icon: User },
    { number: 2, title: 'Details', icon: MapPin },
    { number: 3, title: 'Verify', icon: Calendar },
    { number: 4, title: 'Services', icon: Store },
    { number: 5, title: 'Payout', icon: CreditCard },
  ];

  // Keep step in the URL (replace) so policy-page back returns to the same step.
  useEffect(() => {
    if (loading) return;
    const current = searchParams.get('step');
    if (String(step) === current) return;
    const next = new URLSearchParams(searchParams);
    next.set('step', String(step));
    setSearchParams(next, { replace: true });
  }, [step, loading, searchParams, setSearchParams]);

  // Persist draft so remount after reading a policy does not reset progress.
  useEffect(() => {
    if (!draftReady || !user?.id || isEditMode) return undefined;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          profileSetupDraftKey(user.id),
          JSON.stringify({
            step,
            formData,
            hasVendorBusiness,
            vendorDraft,
            ageDeclarationAccepted,
          })
        );
      } catch {
        /* ignore */
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    draftReady,
    user?.id,
    isEditMode,
    step,
    formData,
    hasVendorBusiness,
    vendorDraft,
    ageDeclarationAccepted,
  ]);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const { user: currentUser } = await authService.requireAuthOrLogin(createPageUrl('ProfileSetup'));
      setUser(currentUser);

      // Prefer /me — avoids bouncing completed accounts back into setup steps.
      try {
        const { userProfile: meProfile } = await authService.getAuthSession();
        if (!isEditMode && meProfile?.onboarding_complete === true) {
          markOnboardingComplete(currentUser.id);
          navigate(createPageUrl('Profile'), { replace: true });
          return;
        }
      } catch {
        /* fall through to profile filter */
      }

      const profiles = await dataService.User.filter({ created_by: currentUser.email });
      const draft = !isEditMode ? loadProfileSetupDraft(currentUser.id) : null;
      const urlStep = Number(searchParams.get('step'));

      if (profiles.length > 0) {
        const profile = profiles[0];
        // Already finished onboarding — don't show setup steps again (edit mode only).
        if (!isEditMode && profile.onboarding_complete === true) {
          markOnboardingComplete(currentUser.id);
          navigate(createPageUrl('Profile'), { replace: true });
          return;
        }
        setUserProfile(profile);
        const profileCity = profile.city || '';
        setFormData((prev) => ({
          ...prev,
          username: profile.username || '',
          bio: profile.bio || '',
          avatar_url: profile.avatar_url || '',
          city: profileCity,
          country_code: normalizeCountryCode(profile.country_code) || prev.country_code,
          region: profile.region || '',
          favorite_drink: profile.favorite_drink || '',
          gender: profile.gender || '',
          date_of_birth: profile.date_of_birth || '',
          latitude: profile.latitude ?? null,
          longitude: profile.longitude ?? null,
          location_label: profile.location_label || '',
          suburb: prev.suburb || '',
          province: prev.province || '',
        }));
        if (profile.has_vendor_interest) setHasVendorBusiness(true);
        if (profile.age_verified || profile.verification_status === 'verified' || profile.verification_status === 'approved') {
          setAgeDeclarationAccepted(true);
        }
      }

      if (draft?.formData && typeof draft.formData === 'object') {
        setFormData((prev) => ({ ...prev, ...draft.formData }));
      }
      if (draft?.hasVendorBusiness === true || draft?.hasVendorBusiness === false) {
        setHasVendorBusiness(draft.hasVendorBusiness);
      }
      if (draft?.vendorDraft && typeof draft.vendorDraft === 'object') {
        setVendorDraft((prev) => ({ ...prev, ...draft.vendorDraft }));
      }
      if (draft?.ageDeclarationAccepted) setAgeDeclarationAccepted(true);

      // URL step wins (back from policy); else draft step; else keep initial.
      if (Number.isFinite(urlStep) && urlStep >= 1 && urlStep <= 5) {
        setStep(urlStep);
      } else if (typeof draft?.step === 'number' && draft.step >= 1 && draft.step <= 5) {
        setStep(draft.step);
      }

      setDraftReady(true);
    } catch {
      // requireAuthOrLogin redirects when no session remains
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (field, e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadProgress((prev) => ({ ...prev, [field]: 'uploading' }));
    setError('');

    try {
      const { file_url } = await integrations.Core.UploadFile({ file });
      setFormData((prev) => ({ ...prev, [field]: file_url }));
      setUploadProgress((prev) => ({ ...prev, [field]: 'done' }));
    } catch (err) {
      setUploadProgress((prev) => ({ ...prev, [field]: 'error' }));
      setError('Failed to upload file');
    }
  };

  const onPickAvatarImage = (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(URL.createObjectURL(file));
    setCropOpen(true);
    e.target.value = '';
  };

  const handleCroppedAvatar = async (file) => {
    setUploadProgress((prev) => ({ ...prev, avatar_url: 'uploading' }));
    setError('');
    try {
      const { file_url } = await integrations.Core.UploadFile({ file });
      setFormData((prev) => ({ ...prev, avatar_url: file_url }));
      setUploadProgress((prev) => ({ ...prev, avatar_url: 'done' }));
    } catch {
      setUploadProgress((prev) => ({ ...prev, avatar_url: 'error' }));
      setError('Failed to upload image');
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

  const resolvedCity = (formData.city || '').trim();

  const canProceed = () => {
    if (step === 1) return formData.username && formData.bio.trim().length > 0;
    if (step === 2) {
      return Boolean(formData.country_code) && Boolean(resolvedCity) && Boolean(formData.favorite_drink);
    }
    if (step === 3) {
      return (
        Boolean(formData.gender) &&
        Boolean(formData.date_of_birth) &&
        isAtLeast18(formData.date_of_birth) &&
        ageDeclarationAccepted
      );
    }
    if (step === 4) {
      if (hasVendorBusiness === false) return true;
      if (hasVendorBusiness === true) return true; // list later allowed; list-now validated on continue
      return false;
    }
    if (step === 5) return false;
    return true;
  };

  const useLiveLocation = async () => {
    setLocating(true);
    setError('');
    try {
      const { getCurrentLocation, locationErrorMessage } = await import('@/lib/getCurrentLocation');
      const { lat, lng } = await getCurrentLocation();
      // Save GPS immediately — nearby discovery only needs coords.
      setFormData((prev) => ({
        ...prev,
        latitude: lat,
        longitude: lng,
        location_label: prev.location_label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      }));
      try {
        const { reverseGeocodeLatLngStructured } = await import('@/lib/reverseGeocode');
        const structured = await reverseGeocodeLatLngStructured(lat, lng);
        const label =
          structured?.formattedAddress || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        const geoCity = (structured?.city || '').trim();
        const geoCountry = normalizeCountryCode(structured?.country);
        setFormData((prev) => {
          const next = {
            ...prev,
            latitude: lat,
            longitude: lng,
            location_label: label,
            suburb: structured?.suburb || prev.suburb || '',
            province: structured?.province || prev.province || '',
          };
          if (geoCity && !prev.city) {
            next.city = geoCity;
            if (geoCountry) next.country_code = geoCountry;
            if (structured?.province) next.region = structured.province;
          }
          return next;
        });
      } catch {
        setFormData((prev) => ({
          ...prev,
          latitude: lat,
          longitude: lng,
          location_label: prev.location_label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        }));
        setError('Saved GPS coordinates — could not resolve a street address.');
      }
    } catch (err) {
      const { locationErrorMessage: msg } = await import('@/lib/getCurrentLocation');
      setError(msg(err));
    } finally {
      setLocating(false);
    }
  };

  const saveVendorIfNeeded = async () => {
    if (hasVendorBusiness !== true) return;
    if (!isVendorListingValid(vendorDraft)) return; // deferred
    await apiPost('/api/vendors', {
      name: vendorDraft.name.trim(),
      category: vendorDraft.category,
      description: vendorDraft.description.trim(),
      website: vendorDraft.website?.trim() || null,
      city: resolvedCity || formData.city || null,
      country: formData.country_code || null,
      latitude: formData.latitude,
      longitude: formData.longitude,
      is_published: true,
      images: (vendorDraft.images || []).map((url, i) => ({ url, sort_order: i })),
    });
  };

  const saveProfile = async (options = {}) => {
    const { paymentCompleted = false, markComplete = !isEditMode } = options;
    setIsSubmitting(true);
    setError('');
    try {
      if (ageDeclarationAccepted && formData.date_of_birth && formData.gender) {
        if (!isAtLeast18(formData.date_of_birth)) {
          setError('You must be at least 18 years old to use SEC Nightlife.');
          setIsSubmitting(false);
          return;
        }
        try {
          await dataService.Legal.acceptDocument({
            document_key: 'age_verification_declaration',
            version: '1.0',
          });
        } catch (legalErr) {
          setError(legalErr?.message || 'Could not record age declaration acceptance.');
          setIsSubmitting(false);
          return;
        }
      }

      const cityValue = resolvedCity || formData.city;
      const listedVendorNow = hasVendorBusiness === true && isVendorListingValid(vendorDraft);
      const deferredVendor = hasVendorBusiness === true && !listedVendorNow;

      const payload = {
        username: formData.username,
        bio: formData.bio,
        city: cityValue,
        country_code: formData.country_code || null,
        region: formData.region || formData.province || null,
        favorite_drink: formData.favorite_drink || null,
        gender: formData.gender || null,
        date_of_birth: formData.date_of_birth || null,
        latitude: formData.latitude,
        longitude: formData.longitude,
        location_label: formData.location_label || null,
        has_vendor_interest: hasVendorBusiness === true,
        vendor_listing_deferred: deferredVendor,
      };
      if (paymentCompleted) payload.payment_setup_complete = true;
      if (markComplete) payload.onboarding_complete = true;
      if (formData.avatar_url) payload.avatar_url = formData.avatar_url;

      if (userProfile) {
        await dataService.User.update(userProfile.id, payload);
      } else {
        await dataService.User.create({ ...payload, onboarding_complete: true });
      }

      try {
        await saveVendorIfNeeded();
      } catch (vendorErr) {
        setError(vendorErr?.message || 'Profile saved but vendor listing failed. You can finish in Settings.');
        if (markComplete && user?.id) {
          markOnboardingComplete(user.id);
          clearProfileSetupDraft(user.id);
          await authService.persistSessionCache().catch(() => {});
        }
        setIsSubmitting(false);
        navigate(createPageUrl(isEditMode ? 'Profile' : 'Home'));
        return;
      }

      if (markComplete && user?.id) {
        markOnboardingComplete(user.id);
        clearProfileSetupDraft(user.id);
        await authService.persistSessionCache().catch(() => {});
      }
      navigate(createPageUrl(isEditMode ? 'Profile' : 'Home'));
    } catch (err) {
      setError(err?.message || 'Failed to save profile. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const completeOnboarding = (options = {}) => saveProfile({ ...options, markComplete: true });

  const handlePaymentSuccess = async () => {
    if (formData.payout_account_name && formData.payout_account_number && formData.payout_bank_code) {
      try {
        await apiPost('/api/payments/payout-recipient', {
          holder_type: 'USER',
          account_name: formData.payout_account_name,
          account_number: formData.payout_account_number,
          bank_code: formData.payout_bank_code,
          currency: 'ZAR',
        });
      } catch (e) {
        setError(e?.message || 'Could not save payout details');
        return;
      }
    }
    await completeOnboarding({ paymentCompleted: Boolean(formData.payout_account_name && formData.payout_account_number && formData.payout_bank_code) });
  };

  const handleSkipPayment = async () => {
    await completeOnboarding({ paymentCompleted: false });
  };

  const handleSkipStep = () => {
    if (step === 4 && hasVendorBusiness === null) {
      setHasVendorBusiness(false);
    }
    if (step < 5) setStep(step + 1);
  };

  const renderFileUpload = (field, label, accept = 'image/*') => (
    <div>
      <Label style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 8, display: 'block' }}>
        {label}
      </Label>
      <label style={{ cursor: 'pointer', display: 'block' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderRadius: 'var(--radius-lg)',
            backgroundColor: formData[field] ? 'var(--sec-accent-muted)' : 'var(--sec-bg-card)',
            border: `1px solid ${formData[field] ? 'var(--sec-accent-border)' : 'var(--sec-border)'}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {uploadProgress[field] === 'uploading' ? (
              <div
                className="animate-spin"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  border: `2px solid var(--sec-accent)`,
                  borderTopColor: 'transparent',
                }}
              />
            ) : formData[field] ? (
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  backgroundColor: 'var(--sec-accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Check size={16} style={{ color: '#000' }} />
              </div>
            ) : (
              <Upload size={20} style={{ color: 'var(--sec-text-muted)' }} />
            )}
            <span style={{ fontSize: 14, color: 'var(--sec-text-secondary)' }}>
              {formData[field] ? 'Uploaded' : `Upload ${label.toLowerCase()}`}
            </span>
          </div>
          {formData[field] && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                setFormData((prev) => ({ ...prev, [field]: '' }));
              }}
              style={{
                padding: 4,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--sec-text-muted)',
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <input
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => handleFileUpload(field, e)}
        />
      </label>
    </div>
  );

  const labelStyle = {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: 'var(--sec-text-muted)',
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };

  const inputStyle = {
    height: 44,
    backgroundColor: 'var(--sec-bg-elevated)',
    border: '1px solid var(--sec-border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--sec-text-primary)',
    fontSize: 16,
  };

  const stepTitleClass = 'text-xl sm:text-2xl font-bold mb-1.5';
  const stepWrapClass = 'space-y-4 sm:space-y-6';
  const navBtnHeight = 46;

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col max-w-full overflow-x-hidden" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
      {/* Header — SecLogo + Sec */}
      <div className="flex items-center justify-center pt-5 sm:pt-8 pb-3 sm:pb-6 max-w-md mx-auto w-full px-5">
        <div className="flex items-center gap-2.5">
          <SecLogo size={26} variant="full" />
          <span className="text-xl sm:text-2xl font-bold" style={{ color: 'var(--sec-text-primary)' }}>
            Sec
          </span>
        </div>
      </div>

      {/* Progress steps */}
      <OnboardingStepIndicator steps={steps} currentStep={step} />

      {/* Form content */}
      <div className="flex-1 max-w-md mx-auto w-full overflow-y-auto px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className={stepWrapClass}
            >
              <div className="text-center mb-5 sm:mb-8">
                <h1 className={stepTitleClass} style={{ color: 'var(--sec-text-primary)' }}>
                  {isEditMode ? 'Edit profile setup' : 'Basics'}
                </h1>
                <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
                  {isEditMode ? 'Update any section — save when you are done' : 'Tell us about yourself'}
                </p>
              </div>

              {/* Avatar */}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <label style={{ cursor: 'pointer' }}>
                  <div style={{ position: 'relative' }}>
                    <div
                      style={{
                        width: 80,
                        height: 80,
                        borderRadius: '50%',
                        border: '1px solid var(--sec-border-strong)',
                        backgroundColor: 'var(--sec-bg-elevated)',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {formData.avatar_url ? (
                        <img
                          src={formData.avatar_url}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <User size={32} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                      )}
                    </div>
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        backgroundColor: 'var(--sec-bg-card)',
                        border: '1px solid var(--sec-border-strong)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Camera size={13} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
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

              <div>
                <div style={labelStyle}>
                  <User size={12} strokeWidth={2} /> Username
                </div>
                <Input
                  value={formData.username}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
                    }))
                  }
                  placeholder="Choose a username"
                  style={inputStyle}
                />
              </div>

              <div>
                <div style={labelStyle}>
                  <FileText size={12} strokeWidth={2} /> Bio
                </div>
                <Textarea
                  value={formData.bio}
                  onChange={(e) => setFormData((prev) => ({ ...prev, bio: e.target.value }))}
                  placeholder="Tell people about yourself…"
                  rows={4}
                  style={{
                    ...inputStyle,
                    height: 'auto',
                    padding: '12px 14px',
                    resize: 'none',
                  }}
                />
              </div>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className={stepWrapClass}
            >
              <div className="text-center mb-5 sm:mb-8">
                <h1 className={stepTitleClass} style={{ color: 'var(--sec-text-primary)' }}>
                  Details
                </h1>
                <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>Where are you? What do you drink?</p>
              </div>

              <CountryCityPicker
                required
                value={{
                  countryCode: formData.country_code,
                  city: formData.city,
                  region: formData.region,
                  latitude: formData.latitude,
                  longitude: formData.longitude,
                }}
                onChange={(next) => {
                  setFormData((prev) => ({
                    ...prev,
                    country_code: next.countryCode || '',
                    city: next.city || '',
                    region: next.region || '',
                    ...(next.latitude != null && next.longitude != null && prev.latitude == null
                      ? { latitude: next.latitude, longitude: next.longitude }
                      : {}),
                  }));
                }}
              />

              <div>
                <div style={labelStyle}>
                  <LocateFixed size={12} strokeWidth={2} /> Preferred location
                </div>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: '0 0 10px' }}>
                  Used when you turn on nearby venues in App Preferences — live GPS or a place you choose.
                </p>
                <button
                  type="button"
                  onClick={useLiveLocation}
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
                    fontWeight: 560,
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
                  showSuburbProvince
                  countryCode={formData.country_code}
                  value={
                    formData.location_label || formData.suburb || formData.province
                      ? {
                          formattedAddress: formData.location_label,
                          latitude: formData.latitude,
                          longitude: formData.longitude,
                          suburb: formData.suburb || '',
                          province: formData.province || '',
                        }
                      : null
                  }
                  onChange={(addr) => {
                    setFormData((prev) => ({
                      ...prev,
                      location_label: addr?.formattedAddress || '',
                      latitude: addr?.latitude ?? null,
                      longitude: addr?.longitude ?? null,
                      suburb: addr?.suburb || '',
                      province: addr?.province || '',
                    }));
                  }}
                />
                {formData.latitude != null && formData.longitude != null ? (
                  <p style={{ fontSize: 12, color: 'var(--sec-accent)', marginTop: 8 }}>
                    Location saved{formData.location_label ? `: ${formData.location_label}` : ''}
                  </p>
                ) : null}
              </div>

              <div>
                <div style={labelStyle}>
                  <Wine size={12} strokeWidth={2} /> Favorite drink
                </div>
                <Select value={formData.favorite_drink || undefined} onValueChange={(v) => setFormData((prev) => ({ ...prev, favorite_drink: v }))}>
                  <SelectTrigger style={{ ...inputStyle, paddingLeft: 14 }}>
                    <SelectValue placeholder="What's your go-to?" />
                  </SelectTrigger>
                  <SelectContent
                    style={{
                      backgroundColor: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      borderRadius: 'var(--radius-lg)',
                    }}
                  >
                    {DRINKS.map((drink) => (
                      <SelectItem key={drink} value={drink} style={{ color: 'var(--sec-text-primary)' }}>
                        {drink}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="step3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className={stepWrapClass}
            >
              <div className="text-center mb-5 sm:mb-8">
                <h1 className={stepTitleClass} style={{ color: 'var(--sec-text-primary)' }}>
                  Age verification
                </h1>
                <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>Confirm your age to access tables, events, and payments</p>
              </div>

              <div>
                <div style={labelStyle}>
                  <User size={12} strokeWidth={2} /> Gender
                </div>
                <Select
                  value={formData.gender || undefined}
                  onValueChange={(v) => setFormData((prev) => ({ ...prev, gender: v }))}
                >
                  <SelectTrigger style={{ ...inputStyle, paddingLeft: 14 }}>
                    <SelectValue placeholder="Select your gender" />
                  </SelectTrigger>
                  <SelectContent
                    style={{
                      backgroundColor: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      borderRadius: 'var(--radius-lg)',
                    }}
                  >
                    {GENDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} style={{ color: 'var(--sec-text-primary)' }}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div style={labelStyle}>
                  <Calendar size={12} strokeWidth={2} /> Date of birth
                </div>
                <Input
                  type="date"
                  value={formData.date_of_birth}
                  onChange={(e) => setFormData((prev) => ({ ...prev, date_of_birth: e.target.value }))}
                  style={inputStyle}
                  required
                />
                {formData.date_of_birth && !isAtLeast18(formData.date_of_birth) ? (
                  <p style={{ fontSize: 12, color: 'var(--sec-error)', marginTop: 8 }}>
                    You must be at least 18 years old to continue.
                  </p>
                ) : null}
              </div>

              <label
                className="flex items-start gap-3 cursor-pointer"
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-lg)',
                  backgroundColor: 'var(--sec-bg-card)',
                  border: '1px solid var(--sec-border)',
                }}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ageDeclarationAccepted}
                  onChange={(e) => setAgeDeclarationAccepted(e.target.checked)}
                />
                <span style={{ fontSize: 13, color: 'var(--sec-text-secondary)', lineHeight: 1.5 }}>
                  I confirm I am 18 or older and accept the{' '}
                  <Link
                    to={createPageUrl('AgeVerificationDeclaration')}
                    style={{ color: 'var(--sec-accent)', textDecoration: 'underline', fontWeight: 600 }}
                  >
                    Age Verification Declaration
                  </Link>
                  , including my responsibility for accurate information and lawful conduct on SEC Nightlife.
                </span>
              </label>

              <div
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-lg)',
                  backgroundColor: 'var(--sec-bg-card)',
                  border: '1px solid var(--sec-border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <FileText size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: 0 }}>
                  Once you continue, your profile will be age-verified automatically. Misrepresenting your age may result in account suspension.
                </p>
              </div>

              {error && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    color: '#ef4444',
                    fontSize: 13,
                  }}
                >
                  {error}
                </div>
              )}
            </motion.div>
          )}

          {step === 4 && (
            <motion.div
              key="step4-services"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className={stepWrapClass}
            >
              <div className="text-center mb-5 sm:mb-8">
                <h1 className={stepTitleClass} style={{ color: 'var(--sec-text-primary)' }}>
                  Vendor services?
                </h1>
                <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
                  Do you run a small vendor business venues might hire — food, equipment, DJ sets, and more?
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { value: true, label: 'Yes' },
                  { value: false, label: 'No' },
                ].map((opt) => {
                  const active = hasVendorBusiness === opt.value;
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      onClick={() => setHasVendorBusiness(opt.value)}
                      style={{
                        height: 48,
                        borderRadius: 'var(--radius-lg)',
                        border: `1px solid ${active ? 'var(--sec-accent-border)' : 'var(--sec-border)'}`,
                        backgroundColor: active ? 'var(--sec-accent-muted)' : 'var(--sec-bg-card)',
                        color: 'var(--sec-text-primary)',
                        fontWeight: 600,
                        fontSize: 15,
                        cursor: 'pointer',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {hasVendorBusiness === true ? (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 'var(--radius-lg)',
                    backgroundColor: 'var(--sec-bg-card)',
                    border: '1px solid var(--sec-border)',
                  }}
                >
                  <p style={{ fontSize: 13, color: 'var(--sec-text-secondary)', margin: '0 0 14px', lineHeight: 1.45 }}>
                    List your business now so venues can find you, or do it later in Settings.
                  </p>
                  <VendorListingForm
                    value={vendorDraft}
                    onChange={setVendorDraft}
                    cityHint={resolvedCity || undefined}
                  />
                </div>
              ) : null}
            </motion.div>
          )}

          {step === 5 && (
            <motion.div
              key="step5"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className={stepWrapClass}
            >
              <div className="text-center mb-5 sm:mb-8">
                <h1 className={stepTitleClass} style={{ color: 'var(--sec-text-primary)' }}>
                  Get paid faster
                </h1>
                <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
                  Add payout details now or later in your Sec Wallet on Profile after you finish setup
                </p>
              </div>

              <div
                style={{
                  padding: 16,
                  borderRadius: 'var(--radius-xl)',
                  backgroundColor: 'var(--sec-bg-card)',
                  border: '1px solid var(--sec-border)',
                }}
              >
                <PayoutTrustBanner className="mb-4" />
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Lock size={20} strokeWidth={1.5} style={{ color: 'var(--sec-accent-muted)', flexShrink: 0 }} />
                  <div>
                    <p style={{ fontSize: 14, color: 'var(--sec-text-primary)', margin: '0 0 8px 0' }}>
                      Weekly payouts with Paystack
                    </p>
                    <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', margin: 0, lineHeight: 1.5 }}>
                      If you earn from paid tables and activities, your earnings are paid out weekly — every Monday, once your balance is at least R50 — when your payout details are set. You can skip now and add or update details later in Sec Wallet on Profile after onboarding. See the{' '}
                      <Link to={createPageUrl('RefundPolicy')} style={{ color: 'var(--sec-accent)', textDecoration: 'underline', fontWeight: 600 }}>
                        Refund Policy
                      </Link>
                      {' '}and{' '}
                      <Link to={createPageUrl('TermsOfService')} style={{ color: 'var(--sec-accent)', textDecoration: 'underline', fontWeight: 600 }}>
                        Terms of Service
                      </Link>
                      .
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <Input
                  placeholder="Account holder name"
                  value={formData.payout_account_name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, payout_account_name: e.target.value }))}
                  style={inputStyle}
                />
                <Input
                  placeholder="Account number"
                  value={formData.payout_account_number}
                  onChange={(e) => setFormData((prev) => ({ ...prev, payout_account_number: e.target.value }))}
                  style={inputStyle}
                />
                <Input
                  placeholder="Bank code"
                  value={formData.payout_bank_code}
                  onChange={(e) => setFormData((prev) => ({ ...prev, payout_bank_code: e.target.value }))}
                  style={inputStyle}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation — steps 1–4: back + continue/skip; step 5: skip / payout */}
      <div className="max-w-md mx-auto w-full pt-4 sm:pt-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] px-5">
        {error ? (
          <div
            className="mb-3"
            style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              if (step === 1) {
                navigate(createPageUrl(isEditMode ? 'Profile' : 'Onboarding'));
              } else {
                setStep(step - 1);
              }
            }}
            style={{
              height: navBtnHeight,
              width: navBtnHeight,
              borderRadius: 'var(--radius-lg)',
              backgroundColor: 'var(--sec-bg-card)',
              border: '1px solid var(--sec-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--sec-text-secondary)',
              flexShrink: 0,
            }}
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
          {isEditMode ? (
            <button
              type="button"
              onClick={() => saveProfile({ paymentCompleted: false, markComplete: false })}
              disabled={isSubmitting}
              style={{
                flex: 1,
                height: navBtnHeight,
                borderRadius: 'var(--radius-lg)',
                backgroundColor: 'var(--sec-accent)',
                color: '#000',
                fontWeight: 600,
                fontSize: 15,
                border: 'none',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </button>
          ) : null}
          {step < 5 ? (
            isEditMode ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={!canProceed()}
                style={{
                  width: navBtnHeight,
                  height: navBtnHeight,
                  borderRadius: 'var(--radius-lg)',
                  backgroundColor: 'var(--sec-bg-card)',
                  color: 'var(--sec-text-secondary)',
                  fontWeight: 600,
                  fontSize: 15,
                  border: '1px solid var(--sec-border)',
                  cursor: canProceed() ? 'pointer' : 'not-allowed',
                  opacity: canProceed() ? 1 : 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <ChevronRight size={20} strokeWidth={2} />
              </button>
            ) : (
              <div className="flex flex-1 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  disabled={!canProceed()}
                  style={{
                    width: '100%',
                    minHeight: navBtnHeight,
                    borderRadius: 'var(--radius-lg)',
                    backgroundColor: 'var(--sec-accent)',
                    color: '#000',
                    fontWeight: 600,
                    fontSize: 15,
                    border: 'none',
                    cursor: canProceed() ? 'pointer' : 'not-allowed',
                    opacity: canProceed() ? 1 : 0.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  {step === 4 && hasVendorBusiness === true && !isVendorListingValid(vendorDraft)
                    ? 'List later'
                    : 'Continue'}
                  <ChevronRight size={20} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={handleSkipStep}
                  style={{
                    width: '100%',
                    minHeight: 42,
                    borderRadius: 'var(--radius-lg)',
                    backgroundColor: 'transparent',
                    color: 'var(--sec-text-secondary)',
                    fontWeight: 500,
                    fontSize: 14,
                    border: '1px solid var(--sec-border)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  Skip for now
                </button>
              </div>
            )
          ) : !isEditMode ? (
            <div className="flex flex-1 flex-col gap-2">
              <button
                type="button"
                onClick={handleSkipPayment}
                disabled={isSubmitting}
                style={{
                  width: '100%',
                  minHeight: navBtnHeight,
                  borderRadius: 'var(--radius-lg)',
                  backgroundColor: 'var(--sec-accent)',
                  color: '#000',
                  fontWeight: 600,
                  fontSize: 15,
                  border: 'none',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                Skip for now
                <ChevronRight size={20} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={handlePaymentSuccess}
                disabled={isSubmitting}
                style={{
                  width: '100%',
                  minHeight: 42,
                  borderRadius: 'var(--radius-lg)',
                  backgroundColor: 'transparent',
                  color: 'var(--sec-text-secondary)',
                  fontWeight: 500,
                  fontSize: 14,
                  border: '1px solid var(--sec-border)',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <CreditCard size={16} strokeWidth={2} />
                Save payout details and finish
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
