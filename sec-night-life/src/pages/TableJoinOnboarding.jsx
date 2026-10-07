import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, Check, DollarSign, Users,
  Calendar, Clock, MapPin, ShieldCheck, CreditCard,
  Sparkles, UserCheck, Heart, CheckCircle2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { motion, AnimatePresence } from 'framer-motion';
import { format, parseISO, isToday, isTomorrow } from 'date-fns';
import RefundPolicyNote from '@/components/legal/RefundPolicyNote';
import { useMoney } from '@/hooks/useMoney';

export default function TableJoinOnboarding() {
  const money = useMoney();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);

  const [formData, setFormData] = useState({
    message: '',
    contribution: 0,
    acceptTerms: false,
    dietaryRestrictions: '',
    phoneNumber: '',
  });

  const urlParams = new URLSearchParams(window.location.search);
  const tableId = urlParams.get('id');

  useEffect(() => { loadUser(); }, []);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        if (currentStep < steps.length - 1 && canProceed()) setCurrentStep(currentStep + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        if (currentStep > 0) setCurrentStep(currentStep - 1);
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentStep]);

  const loadUser = async () => {
    try {
      const currentUser = await authService.loadUserOrLogin(window.location.href);
      setUser(currentUser);
      const profiles = await dataService.User.filter({ created_by: currentUser.email });
      if (profiles.length > 0) setUserProfile(profiles[0]);
    } catch {
      // loadUserOrLogin redirects when no session remains
    }
  };

  const { data: table, isLoading } = useQuery({
    queryKey: ['table', tableId],
    queryFn: async () => { const t = await dataService.Table.filter({ id: tableId }); return t[0]; },
    enabled: !!tableId,
  });

  const { data: event } = useQuery({
    queryKey: ['table-event', table?.event_id],
    queryFn: async () => { const e = await dataService.Event.filter({ id: table.event_id }); return e[0]; },
    enabled: !!table?.event_id,
  });

  const { data: venue } = useQuery({
    queryKey: ['table-venue', table?.venue_id],
    queryFn: async () => { const v = await dataService.Venue.filter({ id: table.venue_id }); return v[0]; },
    enabled: !!table?.venue_id,
  });

  const { data: host } = useQuery({
    queryKey: ['table-host', table?.host_user_id],
    queryFn: async () => { const u = await dataService.User.filter({ id: table.host_user_id }); return u[0]; },
    enabled: !!table?.host_user_id,
  });

  const spendPerPerson = Math.ceil((table?.min_spend || 0) / (table?.max_guests || 1));

  const joinMutation = useMutation({
    mutationFn: async () => {
      const updatedMembers = [
        ...(table.members || []),
        { user_id: userProfile?.id, status: 'pending', joined_at: new Date().toISOString(), contribution: formData.contribution || 0 },
      ];
      await dataService.Table.update(tableId, {
        members: updatedMembers,
        pending_requests: [...(table.pending_requests || []), userProfile?.id],
      });
      await dataService.Notification.create({
        user_id: table.host_user_id,
        type: 'table_request',
        title: 'New Table Request',
        message: `${userProfile?.username || 'Someone'} wants to join your table "${table.name}"`,
        data: { table_id: tableId, user_id: userProfile?.id, message: formData.message, phone: formData.phoneNumber },
        action_url: createPageUrl(`TableDetails?id=${tableId}`),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['table', tableId]);
      setShowSuccessDialog(true);
    },
  });

  const handleComplete = () => joinMutation.mutate();

  const getDateLabel = () => {
    if (!event?.date) return '';
    const d = parseISO(event.date);
    if (isToday(d)) return 'Tonight';
    if (isTomorrow(d)) return 'Tomorrow';
    return format(d, 'EEE, MMM d');
  };

  /* ── shared input style ── */
  const inputStyle = {
    height: 46,
    backgroundColor: 'var(--sec-bg-elevated)',
    border: '1px solid var(--sec-border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--sec-text-primary)',
    fontSize: 16,
  };

  const labelStyle = {
    fontSize: 11, fontWeight: 600, letterSpacing: '0.09em',
    textTransform: 'uppercase', color: 'var(--sec-text-muted)',
    display: 'block', marginBottom: 8,
  };

  /* ── info row inside event card ── */
  const InfoRow = ({ icon: Icon, text }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--sec-text-secondary)' }}>
      <Icon size={14} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
      <span>{text}</span>
    </div>
  );

  /* ── notice card (replaces coloured info boxes) ── */
  const NoticeCard = ({ icon: Icon, title, subtitle }) => (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '14px 16px', borderRadius: 'var(--radius-lg)',
      backgroundColor: 'var(--sec-bg-elevated)',
      border: '1px solid var(--sec-border)',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 'var(--radius-md)', flexShrink: 0,
        backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
      </div>
      <div>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 2 }}>{title}</p>
        {subtitle && <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>{subtitle}</p>}
      </div>
    </div>
  );

  const steps = [
    {
      id: 'welcome',
      title: 'Join the Table',
      icon: Heart,
      component: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Table identity */}
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              backgroundColor: 'var(--sec-bg-elevated)',
              border: '1px solid var(--sec-border-strong)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px',
            }}>
              <Users size={32} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6, color: 'var(--sec-text-primary)' }}>
              {table?.name}
            </h2>
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>Hosted by {host?.username || 'Anonymous'}</p>
          </div>

          {/* Event info card */}
          {event && (
            <div className="sec-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InfoRow icon={Calendar} text={getDateLabel()} />
              <InfoRow icon={Clock} text={event.start_time || 'TBA'} />
              <InfoRow icon={MapPin} text={venue?.name || event.address || 'TBA'} />
            </div>
          )}

          {/* Spend tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="sec-card" style={{ padding: '16px', textAlign: 'center' }}>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em' }}>
                {money.format(table?.min_spend)}
              </p>
              <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Table Min Spend
              </p>
            </div>
            <div className="sec-card" style={{ padding: '16px', textAlign: 'center' }}>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em' }}>
                {money.format(spendPerPerson)}
              </p>
              <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Per Person Est.
              </p>
            </div>
          </div>

          {/* Joining fee */}
          {table?.joining_fee > 0 && (
            <NoticeCard
              icon={DollarSign}
              title={`Joining Fee: R${table.joining_fee}`}
              subtitle="Required upfront to secure your spot"
            />
          )}
        </div>
      ),
    },
    {
      id: 'contact',
      title: 'Contact Info',
      icon: UserCheck,
      component: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6, color: 'var(--sec-text-primary)' }}>
              Let&apos;s get your details
            </h3>
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>The host needs this to coordinate with you</p>
          </div>

          <div>
            <span style={labelStyle}>Phone Number</span>
            <Input
              type="tel"
              placeholder="+27 XX XXX XXXX"
              value={formData.phoneNumber}
              onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
              style={inputStyle}
            />
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>For event coordination and updates</p>
          </div>

          <div>
            <span style={labelStyle}>Message to Host</span>
            <Textarea
              placeholder="Hi! I'd love to join your table…"
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              rows={4}
              style={{
                backgroundColor: 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--sec-text-primary)',
                fontSize: 16, padding: '12px 14px', resize: 'none',
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>Tell the host why you'd like to join (optional)</p>
          </div>

          <div>
            <span style={labelStyle}>Dietary Restrictions (Optional)</span>
            <Input
              placeholder="e.g. Vegetarian, Halal, Allergies…"
              value={formData.dietaryRestrictions}
              onChange={(e) => setFormData({ ...formData, dietaryRestrictions: e.target.value })}
              style={inputStyle}
            />
          </div>
        </div>
      ),
    },
    {
      id: 'contribution',
      title: 'Your Contribution',
      icon: DollarSign,
      component: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6, color: 'var(--sec-text-primary)' }}>
              Spending Commitment
            </h3>
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>How much are you planning to contribute?</p>
          </div>

          <div className="sec-card" style={{ padding: '20px 20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>Minimum per person</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em' }}>
                {money.format(spendPerPerson)}
              </span>
            </div>

            <span style={labelStyle}>Your Contribution</span>
            <div style={{ position: 'relative' }}>
              <span style={{
                position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                fontSize: 15, fontWeight: 600, color: 'var(--sec-text-secondary)',
              }}>R</span>
              <Input
                type="number"
                min={spendPerPerson}
                value={formData.contribution || ''}
                onChange={(e) => setFormData({ ...formData, contribution: parseInt(e.target.value) || 0 })}
                placeholder={spendPerPerson.toString()}
                style={{
                  ...inputStyle, height: 52, paddingLeft: 30,
                  fontSize: 20, fontWeight: 700,
                }}
              />
            </div>
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 8 }}>
              This helps the host manage the table budget
            </p>
          </div>

        </div>
      ),
    },
    {
      id: 'review',
      title: 'Review & Confirm',
      icon: Check,
      component: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6, color: 'var(--sec-text-primary)' }}>
              Review Your Request
            </h3>
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>Make sure everything looks good</p>
          </div>

          {/* Summary rows */}
          {[
            { label: 'Table', value: table?.name },
            { label: 'Your Contact', value: formData.phoneNumber || 'Not provided' },
            formData.message ? { label: 'Your Message', value: formData.message } : null,
          ].filter(Boolean).map(({ label, value }) => (
            <div key={label} className="sec-card" style={{ padding: '14px 16px' }}>
              <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 4 }}>
                {label}
              </p>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)' }}>{value}</p>
            </div>
          ))}

          {/* Contribution highlight */}
          <div className="sec-card" style={{ padding: '14px 16px' }}>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 4 }}>
              Your Contribution
            </p>
            <p style={{ fontSize: 24, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em' }}>
              R{(formData.contribution || spendPerPerson).toLocaleString()}
            </p>
          </div>

          {/* Joining fee */}
          {table?.joining_fee > 0 && (
            <div className="sec-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CreditCard size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)' }}>Joining Fee</p>
                  <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>Via Paystack — secure payment</p>
                </div>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--sec-text-primary)' }}>R{table.joining_fee}</p>
            </div>
          )}

          {table?.joining_fee > 0 ? (
            <div style={{ marginTop: 8 }}>
              <RefundPolicyNote />
            </div>
          ) : null}

          {/* What happens next */}
          <div style={{
            padding: '14px 16px', borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--sec-bg-elevated)',
            border: '1px solid var(--sec-border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Sparkles size={15} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', marginTop: 2, flexShrink: 0 }} />
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 8 }}>What happens next?</p>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {['Host will review your request', "You'll get notified when approved", 'Join the table chat once confirmed'].map((item) => (
                    <li key={item} style={{ fontSize: 12, color: 'var(--sec-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: 'var(--sec-border-strong)', flexShrink: 0 }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      ),
    },
  ];

  const canProceed = () => {
    switch (currentStep) {
      case 0: return true;
      case 1: return formData.phoneNumber.length >= 10;
      case 2: return formData.contribution >= spendPerPerson;
      case 3: return true;
      default: return false;
    }
  };

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!table) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)', padding: '24px' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16, color: 'var(--sec-text-primary)' }}>Table not found</h2>
          <button
            onClick={() => navigate(createPageUrl('Tables'))}
            className="sec-btn sec-btn-primary"
            style={{ padding: '12px 28px' }}
          >
            Browse Tables
          </button>
        </div>
      </div>
    );
  }

  const currentStepData = steps[currentStep];

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)', paddingBottom: 96 }}>

      {/* ── Header with step progress ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 40,
        backgroundColor: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--sec-border)',
        padding: '0 20px',
        paddingTop: 'env(safe-area-inset-top)',
        minHeight: 60,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {/* Back */}
        <button
          onClick={() => currentStep === 0 ? navigate(-1) : setCurrentStep(currentStep - 1)}
          style={{
            width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
            backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--sec-text-secondary)',
          }}
        >
          <ChevronLeft size={18} strokeWidth={2} />
        </button>

        {/* Progress pills — silver filled for completed, dark for pending */}
        <div style={{ flex: 1, display: 'flex', gap: 6 }}>
          {steps.map((step, index) => (
            <div
              key={step.id}
              style={{
                flex: 1, height: 3, borderRadius: 'var(--radius-pill)',
                backgroundColor: index <= currentStep ? 'var(--sec-accent)' : 'var(--sec-border)',
                transition: 'background-color 0.3s ease',
              }}
            />
          ))}
        </div>

        {/* Next */}
        {currentStep < steps.length - 1 ? (
          <button
            onClick={() => setCurrentStep(currentStep + 1)}
            disabled={!canProceed()}
            style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              backgroundColor: canProceed() ? 'var(--sec-text-primary)' : 'var(--sec-bg-card)',
              border: `1px solid ${canProceed() ? 'transparent' : 'var(--sec-border)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: canProceed() ? 'pointer' : 'not-allowed',
              color: canProceed() ? 'var(--sec-bg-base)' : 'var(--sec-text-muted)',
              opacity: canProceed() ? 1 : 0.4,
              transition: 'all 0.15s',
            }}
          >
            <ChevronRight size={18} strokeWidth={2} />
          </button>
        ) : (
          <div style={{ width: 36 }} />
        )}
      </header>

      {/* ── Content ── */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 20px' }}>

        {/* Step label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <currentStepData.icon size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
          </div>
          <div>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 2 }}>
              Step {currentStep + 1} of {steps.length}
            </p>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.01em' }}>
              {currentStepData.title}
            </h1>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.22 }}
          >
            {currentStepData.component}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Sticky bottom CTA bar ── */}
      <div className="sec-bottom-bar">
        <div style={{ width: '100%', maxWidth: 560, margin: '0 auto' }}>
          {currentStep < steps.length - 1 ? (
            <button
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!canProceed()}
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ fontSize: 15, opacity: canProceed() ? 1 : 0.4, cursor: canProceed() ? 'pointer' : 'not-allowed' }}
            >
              Continue
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          ) : (
            <button
              onClick={handleComplete}
              disabled={!canProceed() || joinMutation.isPending}
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ fontSize: 15 }}
            >
              {joinMutation.isPending ? (
                'Sending Request…'
              ) : (
                <>
                  <Check size={18} strokeWidth={2} />
                  Send Request to Host
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Success screen ── */}
      <AnimatePresence>
        {showSuccessDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0,
              backgroundColor: 'var(--sec-bg-base)',
              zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 24,
            }}
          >
            <div style={{ textAlign: 'center', maxWidth: 360 }}>
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', duration: 0.6, bounce: 0.4 }}
                style={{
                  width: 80, height: 80, borderRadius: '50%',
                  backgroundColor: 'var(--sec-bg-elevated)',
                  border: '1px solid var(--sec-border-strong)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 24px',
                }}
              >
                <CheckCircle2 size={38} strokeWidth={1.5} style={{ color: 'var(--sec-text-primary)' }} />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 10, color: 'var(--sec-text-primary)' }}>
                  Request Sent
                </h2>
                <p style={{ fontSize: 14, color: 'var(--sec-text-muted)', lineHeight: 1.65, marginBottom: 32 }}>
                  Your request to join &ldquo;{table?.name}&rdquo; has been sent to the host. You&apos;ll be notified when they respond.
                </p>
                <button
                  onClick={() => navigate(createPageUrl(`TableDetails?id=${tableId}`))}
                  className="sec-btn sec-btn-primary sec-btn-full"
                  style={{ fontSize: 15 }}
                >
                  View Table Details
                </button>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
