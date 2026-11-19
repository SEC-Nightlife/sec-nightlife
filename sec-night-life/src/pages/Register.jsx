import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { clearTokens, apiGet } from '@/api/client';
import { clearSessionCache } from '@/lib/sessionCache';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import SecLogo from '@/components/ui/SecLogo';
import { toast } from 'sonner';
import { Loader2, Check, X } from 'lucide-react';
import { LEGAL_ACCEPT_VERSION } from '@/legal/documentUrls';
import { setPendingLegalAcceptFromRegister } from '@/lib/pendingLegalAccept';
import { prefetchPage } from '@/pages.config';
import SignupPolicyReader, { SIGNUP_POLICY_PAGES } from '@/components/legal/SignupPolicyReader';

function PolicyLink({ page, onOpen, children }) {
  return (
    <button
      type="button"
      className="text-[var(--sec-accent)] underline font-medium bg-transparent border-0 p-0 cursor-pointer inline"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(page);
      }}
      onMouseEnter={() => prefetchPage(page)}
      onFocus={() => prefetchPage(page)}
      onPointerDown={() => prefetchPage(page)}
    >
      {children}
    </button>
  );
}

const ROLE_INTENT_KEY = 'sec-role-intent';

function readStoredRoleIntent() {
  try {
    const intent = localStorage.getItem(ROLE_INTENT_KEY);
    if (intent === 'VENUE' || intent === 'PARTY_GOER') return intent;
  } catch {}
  return 'PARTY_GOER';
}

function getBackendRole(intent) {
  return intent === 'VENUE' ? 'VENUE' : 'USER';
}

export default function Register() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const returnUrl = searchParams.get('returnUrl') || createPageUrl('Home');
  const roleFromUrl = searchParams.get('role');

  const [accountType, setAccountType] = useState(() => {
    if (roleFromUrl === 'VENUE' || roleFromUrl === 'PARTY_GOER') return roleFromUrl;
    return readStoredRoleIntent();
  });

  useEffect(() => {
    if (roleFromUrl === 'PARTY_GOER' || roleFromUrl === 'VENUE') {
      setAccountType(roleFromUrl);
      try {
        localStorage.setItem(ROLE_INTENT_KEY, roleFromUrl);
      } catch {}
    }
  }, [roleFromUrl]);

  const selectAccountType = (intent) => {
    setAccountType(intent);
    try {
      localStorage.setItem(ROLE_INTENT_KEY, intent);
    } catch {}
    const next = new URLSearchParams(searchParams);
    next.set('role', intent);
    setSearchParams(next, { replace: true });
  };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameCheck, setUsernameCheck] = useState(null);
  const [usernameError, setUsernameError] = useState('');
  const [loading, setLoading] = useState(false);
  const [agreedToPolicies, setAgreedToPolicies] = useState(false);
  const [policyDoc, setPolicyDoc] = useState(null);

  useEffect(() => {
    SIGNUP_POLICY_PAGES.forEach((page) => prefetchPage(page));
  }, []);

  const normalizedUsername = useMemo(
    () => username.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
    [username]
  );

  useEffect(() => {
    setUsernameError('');
    if (normalizedUsername.length < 3) {
      setUsernameCheck(normalizedUsername.length === 0 ? null : 'invalid');
      return;
    }
    setUsernameCheck('loading');
    const t = setTimeout(async () => {
      try {
        const res = await apiGet(`/api/users/check-username/${encodeURIComponent(normalizedUsername)}`, {
          skipAuth: true,
        });
        setUsernameCheck(res.available ? 'ok' : 'taken');
      } catch {
        setUsernameCheck(null);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [normalizedUsername]);

  const usernameBlocking =
    !normalizedUsername ||
    normalizedUsername.length < 3 ||
    usernameCheck !== 'ok';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Please enter email and password');
      return;
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (!normalizedUsername) {
      setUsernameError('Username is required.');
      return;
    }
    setUsernameError('');
    if (normalizedUsername.length < 3 || usernameCheck !== 'ok') {
      toast.error('Choose an available username (3–30 characters, letters, numbers, underscores)');
      return;
    }
    if (!agreedToPolicies) {
      toast.error('Please confirm you agree to the User Agreement, Terms of Service, and Privacy Policy');
      return;
    }
    setLoading(true);
    try {
      const r = getBackendRole(accountType);
      const data = await authService.register(
        email.trim(),
        password,
        fullName || undefined,
        r,
        normalizedUsername
      );
      clearTokens();
      clearSessionCache();
      setPendingLegalAcceptFromRegister({
        termsVersion: LEGAL_ACCEPT_VERSION.termsOfService,
        privacyVersion: LEGAL_ACCEPT_VERSION.privacyPolicy,
      });
      if (data?.emailSendFailed) {
        toast.error(
          data.emailSendError
            || 'Account created, but we could not send the verification email. Use Resend verification email on the next screen.',
        );
      } else if (data?.emailVerificationRequired) {
        toast.success('Account created! Check your email to verify before signing in.');
      } else {
        toast.success('Account created!');
      }
      const roleIntent = r === 'VENUE' ? 'VENUE' : 'PARTY_GOER';
      const params = new URLSearchParams();
      if (returnUrl) params.set('returnUrl', returnUrl);
      params.set('role', roleIntent);
      if (data?.emailVerificationRequired || data?.emailSendFailed) {
        params.set('verifyEmail', '1');
        params.set('email', email.trim());
        if (data?.emailSendFailed) params.set('emailSendFailed', '1');
        if (data?.emailSendError) params.set('emailError', data.emailSendError);
      }
      navigate(`${createPageUrl('Login')}?${params.toString()}`, { replace: true });
    } catch (err) {
      const msg = err?.data?.message || err?.data?.error || err?.message || 'Registration failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0A0A0B]">
      <div className="w-full max-w-app md:max-w-app-md">
        <div className="flex flex-col items-center mb-6">
          <SecLogo size={96} asset="transparent" className="mb-4" />
          <h1 className="text-2xl font-bold text-white mb-1">Create Account</h1>
          <p className="text-gray-400">SEC Nightlife</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label className="text-gray-400 mb-2 block">I want to join as</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => selectAccountType('PARTY_GOER')}
                className="min-h-[52px] rounded-xl px-3 py-2 text-sm font-medium border transition-colors"
                style={{
                  backgroundColor:
                    accountType === 'PARTY_GOER' ? 'rgba(212, 175, 55, 0.12)' : '#141416',
                  borderColor:
                    accountType === 'PARTY_GOER' ? 'rgba(212, 175, 55, 0.45)' : '#262629',
                  color: accountType === 'PARTY_GOER' ? 'var(--sec-accent)' : '#e5e5e5',
                }}
              >
                Party Goer
              </button>
              <button
                type="button"
                onClick={() => selectAccountType('VENUE')}
                className="min-h-[52px] rounded-xl px-3 py-2 text-sm font-medium border transition-colors"
                style={{
                  backgroundColor: accountType === 'VENUE' ? 'rgba(212, 175, 55, 0.12)' : '#141416',
                  borderColor: accountType === 'VENUE' ? 'rgba(212, 175, 55, 0.45)' : '#262629',
                  color: accountType === 'VENUE' ? 'var(--sec-accent)' : '#e5e5e5',
                }}
              >
                Business Owner
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {accountType === 'VENUE'
                ? 'Create a venue account to list your business and manage events.'
                : 'Create a guest account to discover venues, join tables, and book nights out.'}
            </p>
          </div>
          <div>
            <Label className="text-gray-400">Full Name</Label>
            <Input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 bg-[#141416] border-[#262629] min-h-[44px]"
              placeholder="Your name"
            />
          </div>
          <div>
            <Label className="text-gray-400">
              Username <span className="text-red-500">*</span>
            </Label>
            <Input
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''));
                setUsernameError('');
              }}
              className={`mt-1 bg-[#141416] border-[#262629] min-h-[44px] ${usernameError ? 'border-red-500' : ''}`}
              placeholder="your_handle"
              autoComplete="username"
              required
              aria-invalid={!!usernameError}
              aria-describedby={
                usernameError ? 'username-err username-status' : 'username-status'
              }
            />
            {usernameError ? (
              <p id="username-err" role="alert" className="mt-1 text-sm text-red-500">
                {usernameError}
              </p>
            ) : null}
            <div id="username-status" className="mt-1 flex items-center gap-2 text-sm min-h-[22px]">
              {usernameCheck === 'loading' && (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                  <span className="text-gray-500">Checking…</span>
                </>
              )}
              {usernameCheck === 'ok' && (
                <>
                  <Check className="w-4 h-4 text-emerald-500" />
                  <span className="text-emerald-500">Username available</span>
                </>
              )}
              {usernameCheck === 'taken' && (
                <>
                  <X className="w-4 h-4 text-red-500" />
                  <span className="text-red-500">Username already taken</span>
                </>
              )}
              {usernameCheck === 'invalid' && (
                <span className="text-amber-500">3–30 characters, letters, numbers, underscores only</span>
              )}
            </div>
          </div>
          <div>
            <Label className="text-gray-400">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 bg-[#141416] border-[#262629] min-h-[44px]"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <Label className="text-gray-400">Password (min 8 characters)</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 bg-[#141416] border-[#262629] min-h-[44px]"
              placeholder="••••••••"
              minLength={8}
              required
            />
            <p className="mt-1 text-xs text-gray-500">Avoid accidental leading/trailing spaces in your password.</p>
          </div>

          <div className="flex gap-3 items-start rounded-xl border border-[#262629] bg-[#141416] p-4">
            <Checkbox
              id="agree-policies"
              checked={agreedToPolicies}
              onCheckedChange={(v) => setAgreedToPolicies(v === true)}
              className="mt-0.5 border-[#52525b] data-[state=checked]:bg-[var(--sec-accent)] data-[state=checked]:border-[var(--sec-accent)]"
            />
            <p className="text-sm text-gray-300 leading-snug">
              <label htmlFor="agree-policies" className="cursor-pointer">
                I agree to the{' '}
              </label>
              <PolicyLink page="UserAgreement" onOpen={setPolicyDoc}>User Agreement</PolicyLink>
              {', '}
              <PolicyLink page="TermsOfService" onOpen={setPolicyDoc}>Terms of Service</PolicyLink>
              {', and '}
              <PolicyLink page="PrivacyPolicy" onOpen={setPolicyDoc}>Privacy Policy</PolicyLink>
              .
            </p>
          </div>

          <Button
            type="submit"
            disabled={loading || usernameBlocking || !agreedToPolicies}
            className="w-full min-h-[44px]"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </Button>
        </form>
        <p className="mt-6 text-center text-gray-500 text-sm">
          Already have an account?{' '}
          <Link
            to={returnUrl ? createPageUrl('Login') + '?returnUrl=' + encodeURIComponent(returnUrl) : createPageUrl('Login')}
            className="text-[var(--sec-accent)] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
      {policyDoc ? (
        <SignupPolicyReader
          page={policyDoc}
          onClose={() => setPolicyDoc(null)}
          onOpen={setPolicyDoc}
        />
      ) : null}
    </div>
  );
}
