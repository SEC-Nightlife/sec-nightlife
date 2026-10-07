import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiGet, apiPatch, apiPost } from '@/api/client';
import { uploadToCloudinary } from '@/lib/cloudinaryUpload';
import {
  JOB_TYPES,
  COMPENSATION_TYPES,
  COMPENSATION_PER,
  jobPostingToEditForm,
  validateJobEditForm,
  buildJobPatchBody,
} from '@/constants/jobPostingForm';
import * as authService from '@/services/authService';
import { toast } from 'sonner';
import RatePromoterDialog from '@/components/promoter/RatePromoterDialog';
import LegalDocLink from '@/components/legal/LegalDocLink';
import { useMoney } from '@/hooks/useMoney';
import { formatZar } from '@/lib/money';

function compensationText(job, fmt = formatZar) {
  if (job.compensationPer === 'COMMISSION') return 'Commission based';
  if (job.compensationType === 'NEGOTIABLE') return 'Negotiable';
  if (job.compensationType === 'UNPAID_TRIAL') return 'Unpaid trial';
  if (job.compensationAmount) return `${fmt(job.compensationAmount)} per ${String(job.compensationPer || 'MONTH').toLowerCase()}`;
  return 'Compensation not specified';
}

function getPublicVisibility(job) {
  if (!job) return { isVisible: false, reason: 'Unknown visibility' };
  if (job.status !== 'OPEN') return { isVisible: false, reason: `Hidden from public (${job.status.toLowerCase()})` };
  if (job.closingDate && new Date(job.closingDate) <= new Date()) return { isVisible: false, reason: 'Hidden from public (expired closing date)' };
  return { isVisible: true, reason: 'Visible to party goers' };
}

const COVER_MIN_CHARS = 50;
const COVER_MAX_CHARS = 1000;

function userCanApplyToJobs(user) {
  if (!user) return false;
  if (['USER', 'FREELANCER', 'VENUE'].includes(user.role)) return true;
  try {
    return localStorage.getItem('sec_active_mode') === 'partygoer';
  } catch {
    return false;
  }
}

export default function JobDetails() {
  const money = useMoney();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(window.location.search);
  const jobId = urlParams.get('id');
  const highlightApplicationId = urlParams.get('application');

  const [user, setUser] = useState(null);
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [coverMessage, setCoverMessage] = useState('');
  const [portfolioUrl, setPortfolioUrl] = useState('');
  const [cvUrl, setCvUrl] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const applicantCardRefs = useRef({});
  const [statusConfirm, setStatusConfirm] = useState({ open: false, applicationId: null, status: null, applicantName: '' });
  const [rateTarget, setRateTarget] = useState(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    requirements: '',
    totalSpots: 1,
    closingDate: '',
  });

  useEffect(() => {
    authService
      .getCurrentUser()
      .then(setUser)
      .catch(() => {
        if (!authService.hasRefreshSession()) setUser(null);
      });
  }, []);

  const { data: job, isLoading } = useQuery({
    queryKey: ['public-job', jobId],
    queryFn: () => apiGet(`/api/jobs/public/${jobId}`),
    enabled: !!jobId,
  });

  const { data: ownerJob, isLoading: ownerJobLoading } = useQuery({
    queryKey: ['owner-job', jobId],
    queryFn: async () => {
      try {
        return await apiGet(`/api/jobs/${jobId}`);
      } catch (err) {
        if (err?.status === 403 || err?.status === 404) return null;
        throw err;
      }
    },
    retry: false,
    enabled: !!jobId && !!user,
  });

  const { data: myApplications = [], isLoading: myAppsLoading, isError: myAppsError } = useQuery({
    queryKey: ['my-apps'],
    queryFn: async () => {
      const rows = await apiGet('/api/jobs/my-applications');
      return Array.isArray(rows) ? rows : [];
    },
    retry: false,
    enabled: !!user,
  });

  const selectedMyApplication = useMemo(() => myApplications.find((x) => x.jobPostingId === jobId), [myApplications, jobId]);

  const coverTrimmed = coverMessage.trim();
  const coverCharsOk = coverTrimmed.length >= COVER_MIN_CHARS && coverTrimmed.length <= COVER_MAX_CHARS;

  const submitApplication = useMutation({
    mutationFn: () =>
      apiPost(`/api/jobs/${jobId}/apply`, {
        coverMessage: coverTrimmed,
        cvUrl: cvUrl?.trim() || null,
        cvFileName: cvFileName?.trim() || null,
        portfolioUrl: portfolioUrl?.trim() || null,
      }),
    onSuccess: async () => {
      toast.success('Application submitted');
      setShowApplyDialog(false);
      await queryClient.invalidateQueries({ queryKey: ['my-apps'] });
      await queryClient.refetchQueries({ queryKey: ['my-apps'] });
      queryClient.invalidateQueries({ queryKey: ['public-job', jobId] });
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Failed to apply'),
  });

  const updateStatus = useMutation({
    mutationFn: ({ applicationId, status }) => apiPatch(`/api/jobs/applications/${applicationId}/status`, { status }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['owner-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['business-inbox'] });
      toast.success('Application updated');
      if (variables.status === 'HIRED' && ownerJob?.positionRole === 'PROMOTER') {
        navigate(createPageUrl(`BusinessMessages?tab=promoters&application=${variables.applicationId}`));
      }
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Failed to update status'),
  });

  const completeApplication = useMutation({
    mutationFn: (applicationId) => apiPatch(`/api/jobs/applications/${applicationId}/complete`, {}),
    onSuccess: () => {
      toast.success('Work marked complete');
      queryClient.invalidateQueries({ queryKey: ['owner-job', jobId] });
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Failed to mark complete'),
  });

  const saveJobEdits = useMutation({
    mutationFn: () => apiPatch(`/api/jobs/${jobId}`, buildJobPatchBody(editForm)),
    onSuccess: () => {
      toast.success('Job updated');
      setShowEditForm(false);
      queryClient.invalidateQueries({ queryKey: ['owner-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['public-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['biz-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['public-jobs'] });
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Failed to update job'),
  });

  const handleSaveJobEdits = () => {
    if (!ownerJob) return;
    const v = validateJobEditForm(editForm, { filledSpots: ownerJob.filledSpots ?? 0 });
    if (!v.ok) {
      toast.error(v.message);
      return;
    }
    saveJobEdits.mutate();
  };

  const openStatusConfirm = ({ applicationId, status, applicantName }) => {
    setStatusConfirm({
      open: true,
      applicationId,
      status,
      applicantName: applicantName || 'this applicant',
    });
  };

  const confirmStatusChange = () => {
    if (!statusConfirm.applicationId || !statusConfirm.status) return;
    updateStatus.mutate({ applicationId: statusConfirm.applicationId, status: statusConfirm.status });
    setStatusConfirm({ open: false, applicationId: null, status: null, applicantName: '' });
  };

  useEffect(() => {
    if (!ownerJob || showEditForm) return;
    setEditForm(jobPostingToEditForm(ownerJob));
  }, [ownerJob, showEditForm]);

  useEffect(() => {
    if (!highlightApplicationId || !ownerJob?.applications?.length) return;
    const el = applicantCardRefs.current[highlightApplicationId];
    if (el?.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightApplicationId, ownerJob?.applications]);

  function openBusinessMessages(application) {
    const tab = application.status === 'HIRED' && ownerJob?.positionRole === 'PROMOTER' ? 'promoters' : 'jobs';
    navigate(createPageUrl(`BusinessMessages?tab=${tab}&application=${application.id}`));
  }

  function openApplicantProfile(applicant) {
    if (!applicant?.id) return;
    navigate(`${createPageUrl('UserProfile')}?id=${encodeURIComponent(applicant.id)}`);
  }

  async function uploadCv(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' || file.size > 5 * 1024 * 1024) {
      toast.error('Upload a PDF up to 5MB');
      return;
    }
    setUploading(true);
    try {
      const data = await uploadToCloudinary(file, {
        resourceType: 'raw',
        folder: 'sec-nightlife/cvs',
      });
      if (!data?.secure_url) throw new Error('Upload succeeded but secure_url is missing');
      setCvUrl(data.secure_url);
      setCvFileName(file.name);
      toast.success('CV uploaded');
    } catch (e) {
      toast.error(e.message || 'Failed to upload CV');
    } finally {
      setUploading(false);
    }
  }

  async function viewCv(applicationId) {
    try {
      const data = await apiGet(`/api/jobs/applications/${applicationId}/cv`);
      const url = data?.viewUrl || data?.cvUrl;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else toast.error('No CV on file');
    } catch (err) {
      toast.error(err?.data?.error || 'Cannot access CV');
    }
  }

  if (isLoading) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><div className="sec-spinner" /></div>;
  if (!job) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>Job not found</div>;

  const spotsRemaining = Math.max((job.totalSpots || 0) - (job.filledSpots || 0), 0);
  const canApply =
    userCanApplyToJobs(user) &&
    !ownerJobLoading &&
    !ownerJob &&
    !myAppsLoading &&
    !myAppsError &&
    !selectedMyApplication &&
    job.status === 'OPEN' &&
    spotsRemaining > 0 &&
    (!job.closingDate || new Date(job.closingDate) > new Date());
  const visibility = getPublicVisibility(ownerJob || job);

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 120 }}>
      <PageBackHeader title={job.title} pageName="JobDetails" />
      <div style={{ padding: 16 }}>
      <div className="sec-card" style={{ padding: 16, borderRadius: 14 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>{job.title}</h1>
        <p style={{ marginTop: 6, color: 'var(--sec-text-muted)' }}>{job.venue?.name} · {job.venue?.city} · {job.venue?.venueType}</p>
        <p style={{ marginTop: 8, fontSize: 13 }}><strong>{compensationText(job, money.format)}</strong></p>
        <p style={{ marginTop: 8, fontSize: 13, color: 'var(--sec-text-muted)' }}>{spotsRemaining} spots left</p>
        {job.closingDate ? <p style={{ marginTop: 8, fontSize: 13, color: 'var(--sec-text-muted)' }}>Closes {new Date(job.closingDate).toLocaleDateString()}</p> : <p style={{ marginTop: 8, fontSize: 13, color: 'var(--sec-text-muted)' }}>No closing date</p>}
        <h3 style={{ marginTop: 14 }}>Description</h3>
        <p style={{ color: 'var(--sec-text-secondary)', whiteSpace: 'pre-wrap' }}>{job.description}</p>
        <h3 style={{ marginTop: 14 }}>Requirements</h3>
        <p style={{ color: 'var(--sec-text-secondary)', whiteSpace: 'pre-wrap' }}>{job.requirements}</p>
      </div>

      {canApply ? (
        <button type="button" onClick={() => setShowApplyDialog(true)} className="sec-btn sec-btn-primary w-full" style={{ marginTop: 14, height: 48 }}>Apply</button>
      ) : selectedMyApplication ? (
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="sec-badge sec-badge-success">Applied</div>
          <div className="sec-badge sec-badge-muted">Status: {selectedMyApplication.status}</div>
          {['SHORTLISTED', 'HIRED'].includes(selectedMyApplication.status) ? (
            <button
              type="button"
              className="sec-btn sec-btn-secondary sec-btn-sm"
              onClick={() =>
                navigate(
                  createPageUrl(
                    `MyJobApplications?applicationId=${selectedMyApplication.id}&jobId=${jobId}`,
                  ),
                )
              }
            >
              Open messages
            </button>
          ) : null}
        </div>
      ) : myAppsError ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>
          Unable to verify application state right now.
        </p>
      ) : user && !userCanApplyToJobs(user) && !ownerJob ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>
          Switch to Party Goer mode in the menu to apply for jobs.
        </p>
      ) : !user ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>Sign in to apply for this job.</p>
      ) : job.status !== 'OPEN' ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>This job is no longer accepting applications.</p>
      ) : spotsRemaining <= 0 ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>All spots have been filled.</p>
      ) : job.closingDate && new Date(job.closingDate) <= new Date() ? (
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--sec-text-muted)' }}>Applications are closed for this job.</p>
      ) : null}

      {ownerJob ? (
        <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
          <div>
            <span className={`sec-badge ${visibility.isVisible ? 'sec-badge-success' : 'sec-badge-danger'}`}>{visibility.reason}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h2>Applicants</h2>
            <button
              className="sec-btn sec-btn-secondary"
              type="button"
              style={{ height: 40 }}
              onClick={() => {
                setShowEditForm((v) => {
                  const next = !v;
                  if (next) setEditForm(jobPostingToEditForm(ownerJob));
                  return next;
                });
              }}
            >
              {showEditForm ? 'Cancel Edit' : 'Edit Job'}
            </button>
          </div>
          {showEditForm ? (
            <div className="sec-card" style={{ padding: 16, borderRadius: 12, display: 'flex', flexDirection: 'column', maxHeight: 'min(85vh, 720px)', overflow: 'hidden' }}>
              <div>
                <span className={`sec-badge ${visibility.isVisible ? 'sec-badge-success' : 'sec-badge-danger'}`}>{visibility.reason}</span>
              </div>
              <div style={{ overflowY: 'auto', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 }}>
                <div>
                  <Label className="text-gray-400 text-sm">Job title *</Label>
                  <Input
                    value={editForm.title}
                    onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))}
                    className="mt-1.5 h-11 rounded-xl"
                    style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                  />
                </div>
                <div>
                  <Label className="text-gray-400 text-sm">Job type *</Label>
                  <Select value={editForm.jobType} onValueChange={(v) => setEditForm((p) => ({ ...p, jobType: v }))}>
                    <SelectTrigger className="mt-1.5 h-11 rounded-xl" style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}>
                      {JOB_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-gray-400 text-sm">Job description *</Label>
                  <Textarea
                    value={editForm.description}
                    onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))}
                    className="mt-1.5 rounded-xl resize-y min-h-[100px]"
                    style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    rows={4}
                  />
                </div>
                <div>
                  <Label className="text-gray-400 text-sm">Requirements *</Label>
                  <Textarea
                    value={editForm.requirements}
                    onChange={(e) => setEditForm((p) => ({ ...p, requirements: e.target.value }))}
                    className="mt-1.5 rounded-xl resize-y min-h-[100px]"
                    style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    rows={4}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <Label className="text-gray-400 text-sm">Compensation type *</Label>
                    <Select value={editForm.compensationType} onValueChange={(v) => setEditForm((p) => ({ ...p, compensationType: v }))}>
                      <SelectTrigger className="mt-1.5 h-11 rounded-xl" style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}>
                        {COMPENSATION_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-gray-400 text-sm">Currency</Label>
                    <Input
                      value={editForm.currency}
                      onChange={(e) => setEditForm((p) => ({ ...p, currency: e.target.value.toUpperCase() }))}
                      className="mt-1.5 h-11 rounded-xl"
                      style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    />
                  </div>
                </div>
                {['FIXED', 'NEGOTIABLE'].includes(editForm.compensationType) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <Label className="text-gray-400 text-sm">Amount</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.compensationAmount}
                        onChange={(e) => setEditForm((p) => ({ ...p, compensationAmount: e.target.value }))}
                        className="mt-1.5 h-11 rounded-xl"
                        style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                      />
                    </div>
                    <div>
                      <Label className="text-gray-400 text-sm">Paid per</Label>
                      <Select value={editForm.compensationPer} onValueChange={(v) => setEditForm((p) => ({ ...p, compensationPer: v }))}>
                        <SelectTrigger className="mt-1.5 h-11 rounded-xl" style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}>
                          {COMPENSATION_PER.map((t) => (
                            <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <Label className="text-gray-400 text-sm">Total spots</Label>
                    <Input
                      type="number"
                      min={1}
                      value={editForm.totalSpots}
                      onChange={(e) => setEditForm((p) => ({ ...p, totalSpots: e.target.value }))}
                      className="mt-1.5 h-11 rounded-xl"
                      style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    />
                  </div>
                  <div>
                    <Label className="text-gray-400 text-sm">Closing date</Label>
                    <Input
                      type="date"
                      value={editForm.closingDate}
                      onChange={(e) => setEditForm((p) => ({ ...p, closingDate: e.target.value }))}
                      className="mt-1.5 h-11 rounded-xl"
                      style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    />
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 14, flexShrink: 0, paddingTop: 12, borderTop: '1px solid var(--sec-border)' }}>
                <button
                  className="sec-btn sec-btn-primary w-full"
                  type="button"
                  style={{ height: 48, borderRadius: 12 }}
                  disabled={saveJobEdits.isPending}
                  onClick={handleSaveJobEdits}
                >
                  {saveJobEdits.isPending ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </div>
          ) : null}
          {ownerJob.applications?.length ? ownerJob.applications.map((a) => (
            <div
              key={a.id}
              ref={(el) => {
                if (el) applicantCardRefs.current[a.id] = el;
              }}
              className="sec-card"
              style={{
                padding: 16,
                borderRadius: 14,
                display: 'grid',
                gap: 10,
                border:
                  highlightApplicationId === a.id
                    ? '1px solid var(--sec-accent-border)'
                    : '1px solid var(--sec-border)',
                boxShadow: highlightApplicationId === a.id ? 'var(--shadow-card)' : undefined,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontWeight: 700, margin: 0, fontSize: 16 }}>{a.applicant?.fullName || 'Applicant'}</p>
                  <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                    {a.applicant?.userProfile?.username ? `@${a.applicant.userProfile.username} · ` : ''}
                    {a.applicant?.email}
                  </p>
                  {a.applicant?.userProfile?.isVerifiedPromoter ? (
                    <span className="sec-badge sec-badge-gold" style={{ marginTop: 6, display: 'inline-block' }}>
                      Verified promoter
                    </span>
                  ) : null}
                  {a.appliedAt ? (
                    <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 6, marginBottom: 0 }}>
                      Applied {new Date(a.appliedAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <span className="sec-badge sec-badge-muted">{a.status === 'SHORTLISTED' ? 'WAITLISTED' : a.status}</span>
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5, color: 'var(--sec-text-secondary)' }}>{a.coverMessage}</p>
              {a.portfolioUrl ? (
                <a
                  href={a.portfolioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: 'var(--sec-accent)', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  Open portfolio
                </a>
              ) : null}
              <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))', gap: 8 }}>
                <button type="button" className="sec-btn sec-btn-secondary sec-btn-sm" style={{ width: '100%' }} onClick={() => openApplicantProfile(a.applicant)}>View profile</button>
                <button type="button" className="sec-btn sec-btn-secondary sec-btn-sm" style={{ width: '100%' }} onClick={() => viewCv(a.id)}>View CV</button>
                {a.status !== 'SHORTLISTED' ? <button type="button" className="sec-btn sec-btn-secondary sec-btn-sm" style={{ width: '100%' }} onClick={() => updateStatus.mutate({ applicationId: a.id, status: 'SHORTLISTED' })}>Add to waitlist</button> : null}
                {a.status !== 'REJECTED' ? <button type="button" className="sec-btn sec-btn-secondary sec-btn-sm" style={{ width: '100%' }} onClick={() => openStatusConfirm({ applicationId: a.id, status: 'REJECTED', applicantName: a.applicant?.fullName })}>Reject</button> : null}
                {a.status !== 'HIRED' ? <button type="button" className="sec-btn sec-btn-primary sec-btn-sm" style={{ width: '100%' }} onClick={() => openStatusConfirm({ applicationId: a.id, status: 'HIRED', applicantName: a.applicant?.fullName })}>Hire</button> : null}
                {a.status === 'HIRED' ? (
                  <button
                    type="button"
                    className="sec-btn sec-btn-secondary sec-btn-sm"
                    style={{ width: '100%' }}
                    onClick={() => completeApplication.mutate(a.id)}
                  >
                    Mark Complete
                  </button>
                ) : null}
                {a.status === 'HIRED' ? (
                  <button
                    type="button"
                    className="sec-btn sec-btn-secondary sec-btn-sm"
                    style={{ width: '100%' }}
                    onClick={() => setRateTarget({ id: a.applicant?.id, username: a.applicant?.fullName || a.applicant?.email, contextId: ownerJob.id })}
                  >
                    Rate Promoter
                  </button>
                ) : null}
                {['SHORTLISTED', 'HIRED'].includes(a.status) ? (
                  <button type="button" className="sec-btn sec-btn-secondary sec-btn-sm" style={{ width: '100%' }} onClick={() => openBusinessMessages(a)}>Open messages</button>
                ) : null}
              </div>
            </div>
          )) : (
            <div className="sec-card" style={{ padding: 14, borderRadius: 12, color: 'var(--sec-text-muted)' }}>
              No applicants yet.
            </div>
          )}
        </div>
      ) : null}

      <Dialog
        open={statusConfirm.open}
        onOpenChange={(open) => setStatusConfirm((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-md border-[var(--sec-border)] bg-[var(--sec-bg-card)] text-[var(--sec-text-primary)]">
          <DialogHeader>
            <DialogTitle>
              {statusConfirm.status === 'HIRED' ? 'Confirm hiring decision' : 'Confirm rejection'}
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--sec-text-muted)' }}>
              {statusConfirm.status === 'HIRED'
                ? `Are you sure you want to mark ${statusConfirm.applicantName} as hired?`
                : `Are you sure you want to reject ${statusConfirm.applicantName}? They will no longer be able to message you unless their status is later changed to shortlisted or hired.`}
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              className="sec-btn sec-btn-secondary"
              style={{ height: 44, flex: 1 }}
              onClick={() => setStatusConfirm({ open: false, applicationId: null, status: null, applicantName: '' })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sec-btn sec-btn-primary"
              style={{ height: 44, flex: 1 }}
              onClick={confirmStatusChange}
              disabled={updateStatus.isPending}
            >
              {updateStatus.isPending ? 'Updating...' : 'Confirm'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showApplyDialog} onOpenChange={setShowApplyDialog}>
        <DialogContent className="max-w-lg gap-0 border-[var(--sec-border)] bg-[var(--sec-bg-card)] p-0 text-[var(--sec-text-primary)] overflow-hidden">
          <div
            style={{
              padding: '20px 22px 16px',
              borderBottom: '1px solid var(--sec-border)',
              background: 'linear-gradient(165deg, var(--sec-bg-elevated) 0%, var(--sec-bg-card) 100%)',
            }}
          >
            <DialogHeader className="space-y-2 text-left">
              <DialogTitle style={{ fontSize: 20, fontWeight: 700 }}>Apply for this role</DialogTitle>
              <DialogDescription style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>
                {job.title} · {job.venue?.name}
              </DialogDescription>
            </DialogHeader>
          </div>
          <div style={{ padding: '18px 22px 22px', display: 'grid', gap: 16, maxHeight: 'min(70vh, 520px)', overflowY: 'auto' }}>
            <div>
              <Label style={{ fontSize: 12, color: 'var(--sec-text-secondary)' }}>Cover letter</Label>
              <Textarea
                value={coverMessage}
                onChange={(e) => setCoverMessage(e.target.value)}
                placeholder="Tell the venue why you’re a great fit — experience, availability, and what you bring to the role."
                className="mt-2 min-h-[140px] border-[var(--sec-border)] bg-[var(--sec-bg-elevated)]"
                maxLength={COVER_MAX_CHARS}
              />
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: coverCharsOk ? 'var(--sec-text-muted)' : 'var(--sec-warning, #f59e0b)',
                }}
              >
                {coverTrimmed.length} / {COVER_MIN_CHARS} minimum · {COVER_MAX_CHARS} max
                {!coverCharsOk && coverTrimmed.length < COVER_MIN_CHARS
                  ? ` — add ${COVER_MIN_CHARS - coverTrimmed.length} more character${COVER_MIN_CHARS - coverTrimmed.length === 1 ? '' : 's'}`
                  : ''}
              </div>
            </div>
            <div>
              <Label style={{ fontSize: 12, color: 'var(--sec-text-secondary)' }}>Portfolio link (optional)</Label>
              <input
                type="url"
                className="sec-input-rect mt-2"
                style={{ height: 44, width: '100%' }}
                value={portfolioUrl}
                onChange={(e) => setPortfolioUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div>
              <Label style={{ fontSize: 12, color: 'var(--sec-text-secondary)' }}>CV (PDF, max 5MB)</Label>
              <input
                type="file"
                accept="application/pdf,.pdf"
                className="sec-input-rect mt-2"
                style={{ padding: 10, width: '100%' }}
                onChange={(e) => uploadCv(e.target.files?.[0])}
              />
              {uploading ? <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 8 }}>Uploading CV…</p> : null}
              {cvFileName ? (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid var(--sec-border)',
                    background: 'var(--sec-bg-elevated)',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cvFileName}</span>
                  <button
                    type="button"
                    className="sec-btn sec-btn-ghost sec-btn-sm"
                    onClick={() => {
                      setCvFileName('');
                      setCvUrl('');
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', lineHeight: 1.55 }}>
              By applying you agree to the{' '}
              <LegalDocLink pageName="PromoterCodeOfConduct">Promoter Code of Conduct</LegalDocLink> and{' '}
              <LegalDocLink pageName="CommunityGuidelines">Community Guidelines</LegalDocLink>.
            </p>
          </div>
          <div
            style={{
              padding: '14px 22px 20px',
              borderTop: '1px solid var(--sec-border)',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
            }}
          >
            <button type="button" className="sec-btn sec-btn-secondary" style={{ height: 46 }} onClick={() => setShowApplyDialog(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="sec-btn sec-btn-primary"
              style={{ height: 46, fontWeight: 700 }}
              disabled={submitApplication.isPending || !coverCharsOk}
              onClick={() => submitApplication.mutate()}
            >
              {submitApplication.isPending ? 'Submitting…' : 'Submit application'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <RatePromoterDialog
        isOpen={!!rateTarget}
        onClose={() => setRateTarget(null)}
        promoter={rateTarget || { id: '', username: '' }}
        context="job"
        contextId={rateTarget?.contextId || ownerJob?.id || ''}
      />
      </div>
    </div>
  );
}