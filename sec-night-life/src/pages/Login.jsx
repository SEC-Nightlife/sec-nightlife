import React, { useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { getRefreshToken } from '@/api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import SecLogo from '@/components/ui/SecLogo';
import { prefetchPage } from '@/pages.config';
import { toast } from 'sonner';

const ROLE_INTENT_KEY = 'sec-role-intent';
const STAFF_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MODERATOR'];
const DEFAULT_RESEND_COOLDOWN_SEC = 60;

function formatCooldown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function readStoredConsumerIntent() {
  try {
    const intent = localStorage.getItem(ROLE_INTENT_KEY);
    if (intent === 'VENUE' || intent === 'PARTY_GOER') return intent;
  } catch {}
  return 'PARTY_GOER';
}

export default function Login() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const roleParam = searchParams.get('role');
  const verifyEmailParam = searchParams.get('verifyEmail') === '1';
  const emailSendFailedParam = searchParams.get('emailSendFailed') === '1';
  const emailFromRegister = searchParams.get('email') || '';
  const defaultReturnUrl =
    roleParam === 'VENUE' ? createPageUrl('BusinessDashboard') : createPageUrl('Home');
  const returnUrl = searchParams.get('returnUrl') || defaultReturnUrl;

  const isStaffRole = roleParam && STAFF_ROLES.includes(roleParam);
  const [email, setEmail] = useState(emailFromRegister);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [showVerifyNotice, setShowVerifyNotice] = useState(verifyEmailParam);
  const [accountType, setAccountType] = useState(() => {
    if (roleParam === 'VENUE' || roleParam === 'PARTY_GOER') return roleParam;
    return readStoredConsumerIntent();
  });

  const [step, setStep] = useState('credentials');
  const [loginChallengeToken, setLoginChallengeToken] = useState('');
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (roleParam === 'VENUE' || roleParam === 'PARTY_GOER') {
      setAccountType(roleParam);
      try {
        localStorage.setItem(ROLE_INTENT_KEY, roleParam);
      } catch {}
    }
  }, [roleParam]);

  const selectAccountType = (intent) => {
    setAccountType(intent);
    try {
      localStorage.setItem(ROLE_INTENT_KEY, intent);
    } catch {}
    const next = new URLSearchParams(searchParams);
    next.set('role', intent);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    void prefetchPage('Register');
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!getRefreshToken()) return undefined;
    const expectedRole = isStaffRole
      ? roleParam
      : accountType === 'VENUE'
        ? 'VENUE'
        : 'USER';
    (async () => {
      try {
        const ok = await authService.ensureSession();
        if (!ok || cancelled) return;
        const { user } = await authService.getAuthSession();
        if (!user || cancelled) return;
        // Multi-role emails: only auto-skip Login when session matches Party Goer / Business choice.
        if (expectedRole && user.role && String(user.role) !== String(expectedRole)) {
          return;
        }
        navigate(returnUrl, { replace: true });
      } catch {
        // stay on login form
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, returnUrl, accountType, roleParam, isStaffRole]);

  useEffect(() => {
    if (step !== 'otp' || resendCooldown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, resendCooldown]);

  const consumerIntent = !isStaffRole
    ? accountType
    : roleParam === 'VENUE' || roleParam === 'PARTY_GOER'
      ? roleParam
      : readStoredConsumerIntent();

  const registerHref = (() => {
    const base = returnUrl
      ? `${createPageUrl('Register')}?returnUrl=${encodeURIComponent(returnUrl)}`
      : createPageUrl('Register');
    const intent = !isStaffRole ? consumerIntent : readStoredConsumerIntent();
    return `${base}${base.includes('?') ? '&' : '?'}role=${encodeURIComponent(intent)}`;
  })();

  const forgotHref = email.trim()
    ? `${createPageUrl('ForgotPassword')}?email=${encodeURIComponent(email.trim())}`
    : createPageUrl('ForgotPassword');

  const redirectAfterLogin = async () => {
    // Login/OTP already wrote session cache via cacheSessionAfterTokens — skip extra /me.
    try {
      if (consumerIntent === 'VENUE') {
        localStorage.setItem('sec_active_mode', 'business');
      } else if (consumerIntent === 'PARTY_GOER') {
        localStorage.setItem('sec_active_mode', 'partygoer');
      }
    } catch {
      // ignore storage errors
    }
    const path =
      returnUrl && returnUrl.startsWith('/')
        ? returnUrl
        : '/' + (returnUrl || 'Home').replace(/^\/+/, '');
    window.location.href = window.location.origin + path;
  };

  const resolveLoginRole = () => {
    if (isStaffRole) return roleParam;
    return consumerIntent === 'VENUE' ? 'VENUE' : 'USER';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setEmailNotVerified(false);
    if (!email || !password) {
      const message = 'Please enter email and password';
      setError(message);
      toast.error(message);
      return;
    }
    setLoading(true);
    try {
      const result = await authService.login(email.trim(), password, resolveLoginRole());
      if (result.requiresOtp) {
        setLoginChallengeToken(result.loginChallengeToken);
        setResendCooldown(result.resendAvailableInSeconds ?? DEFAULT_RESEND_COOLDOWN_SEC);
        setStep('otp');
        setOtp('');
        toast.success('Check your email for a 6-digit sign-in code');
        return;
      }
      toast.success('Signed in successfully');
      await redirectAfterLogin();
    } catch (err) {
      const code = err?.data?.code;
      if (code === 'EMAIL_NOT_VERIFIED') {
        setEmailNotVerified(true);
      }
      const message = err?.data?.error || err?.message || 'Sign in failed';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email.trim()) {
      toast.error('Enter your email address first');
      return;
    }
    setResendLoading(true);
    try {
      await authService.resendVerificationEmail(email.trim());
      toast.success('If your account is unverified, a new link was sent to your email');
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Could not resend verification email');
    } finally {
      setResendLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) {
      toast.error('Enter the 6-digit code');
      return;
    }
    setOtpLoading(true);
    try {
      await authService.verifyLoginOtp(loginChallengeToken, otp);
      toast.success('Signed in successfully');
      await redirectAfterLogin();
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Invalid code');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setOtpLoading(true);
    try {
      const data = await authService.resendLoginOtp(loginChallengeToken);
      if (data?.loginChallengeToken) setLoginChallengeToken(data.loginChallengeToken);
      setResendCooldown(data?.resendAvailableInSeconds ?? DEFAULT_RESEND_COOLDOWN_SEC);
      toast.success('A new code was sent to your email');
    } catch (err) {
      const retryAfter = err?.data?.retryAfterSeconds;
      if (typeof retryAfter === 'number' && retryAfter > 0) {
        setResendCooldown(retryAfter);
      }
      toast.error(err?.data?.error || err?.message || 'Could not resend code');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleBackFromOtp = async () => {
    if (loginChallengeToken) {
      await authService.cancelLoginOtp(loginChallengeToken).catch(() => {});
    }
    setStep('credentials');
    setOtp('');
    setLoginChallengeToken('');
    setResendCooldown(0);
  };

  return (
    <div className="min-h-screen flex items-start justify-center overflow-y-auto p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] bg-[#0A0A0B]">
      <div className="w-full max-w-md my-auto py-6">
        <div className="flex flex-col items-center mb-6">
          <SecLogo size={104} asset="transparent" className="mb-4" />
          <h1 className="text-2xl font-bold text-white mb-1">
            {step === 'otp' ? 'Enter sign-in code' : 'Sign In'}
          </h1>
          <p className="text-gray-400">SEC Nightlife</p>
        </div>

        {step === 'otp' ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-400 text-center">
              We emailed a 6-digit sign-in code to <span className="text-white">{email}</span>
            </p>
            <p className="text-xs text-gray-500 text-center">
              Check your inbox and spam folder. The code expires in 10 minutes.
            </p>
            <div className="flex justify-center">
              <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button type="button" disabled={otpLoading} className="w-full" onClick={handleVerifyOtp}>
              {otpLoading ? 'Verifying…' : 'Verify and sign in'}
            </Button>
            <div className="flex flex-col gap-2 text-center text-sm">
              <button
                type="button"
                className="text-[var(--sec-accent)] hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                onClick={handleResendOtp}
                disabled={otpLoading || resendCooldown > 0}
              >
                {resendCooldown > 0
                  ? `Resend code in ${formatCooldown(resendCooldown)}`
                  : 'Resend code'}
              </button>
              <button
                type="button"
                className="text-gray-500 hover:underline"
                onClick={handleBackFromOtp}
              >
                Back to sign in
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {showVerifyNotice && (
              <div className="rounded-xl border border-[rgba(212,175,55,0.35)] bg-[rgba(212,175,55,0.08)] px-4 py-3 text-sm text-[var(--sec-text-secondary)]">
                <p className="font-medium text-[var(--sec-accent)] mb-1">Verify your email before signing in</p>
                <p>
                  {emailSendFailedParam
                    ? 'Your account was created, but we could not send the verification email. Tap Resend verification email below, then check your inbox (and spam).'
                    : 'Your account was created. Open the verification link we sent to your email, then come back here to sign in. Check spam if you do not see it.'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resendLoading || !email.trim()}
                  onClick={async () => {
                    setEmailNotVerified(true);
                    await handleResendVerification();
                  }}
                  className="w-full mt-3"
                >
                  {resendLoading ? 'Sending…' : 'Resend verification email'}
                </Button>
                <button
                  type="button"
                  className="mt-2 w-full text-xs text-gray-500 hover:underline"
                  onClick={() => {
                    setShowVerifyNotice(false);
                    const next = new URLSearchParams(searchParams);
                    next.delete('verifyEmail');
                    next.delete('emailSendFailed');
                    setSearchParams(next, { replace: true });
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
                {emailNotVerified && (
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={resendLoading}
                      onClick={handleResendVerification}
                      className="w-full"
                    >
                      {resendLoading ? 'Sending…' : 'Resend verification email'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {isStaffRole && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200/90">
                Signing in with staff role: <span className="font-mono">{roleParam}</span>
              </div>
            )}

            {!isStaffRole && (
              <div>
                <Label className="text-gray-400 mb-2 block">Sign in as</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => selectAccountType('PARTY_GOER')}
                    className="min-h-[48px] rounded-xl px-3 py-2 text-sm font-medium border transition-colors"
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
                    className="min-h-[48px] rounded-xl px-3 py-2 text-sm font-medium border transition-colors"
                    style={{
                      backgroundColor:
                        accountType === 'VENUE' ? 'rgba(212, 175, 55, 0.12)' : '#141416',
                      borderColor:
                        accountType === 'VENUE' ? 'rgba(212, 175, 55, 0.45)' : '#262629',
                      color: accountType === 'VENUE' ? 'var(--sec-accent)' : '#e5e5e5',
                    }}
                  >
                    Business Owner
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                  Party Goer and Business are separate accounts on the same email. Choose the one you
                  want before signing in.
                </p>
              </div>
            )}

            <div>
              <Label className="text-gray-400">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 bg-[#141416] border-[#262629]"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <Label className="text-gray-400">Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 bg-[#141416] border-[#262629]"
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <p className="mt-1 text-xs text-gray-500">Tip: avoid accidental spaces before or after your password.</p>
              <p className="mt-2 text-right">
                <Link to={forgotHref} className="text-xs text-[var(--sec-accent)] hover:underline">
                  Forgot password?
                </Link>
              </p>
            </div>
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
            <p className="text-center text-xs text-gray-500 leading-relaxed">
              By signing in you agree to our{' '}
              <Link to={createPageUrl('UserAgreement')} className="text-[var(--sec-accent)] hover:underline">
                User Agreement
              </Link>
              ,{' '}
              <Link to={createPageUrl('TermsOfService')} className="text-[var(--sec-accent)] hover:underline">
                Terms of Service
              </Link>
              , and{' '}
              <Link to={createPageUrl('PrivacyPolicy')} className="text-[var(--sec-accent)] hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </form>
        )}

        {step !== 'otp' && (
          <>
            <p className="mt-6 text-center text-gray-500 text-sm">
              Don&apos;t have an account?{' '}
              <Link to={registerHref} className="text-[var(--sec-accent)] hover:underline">
                Sign up
              </Link>
            </p>
            <p className="mt-4 text-center">
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.setItem('sec_enter_seen_v1', '1');
                  } catch {
                    /* ignore */
                  }
                  navigate(createPageUrl('Home'), { replace: true });
                }}
                className="text-sm font-medium text-[var(--sec-accent)] hover:underline"
              >
                Continue without an account
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
