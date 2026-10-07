import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Calendar, ChevronRight, MapPin, Search } from 'lucide-react';
import { motion } from 'framer-motion';
import { differenceInDays } from 'date-fns';
import { apiGet } from '@/api/client';
import LegalDocLink from '@/components/legal/LegalDocLink';
import FeedScopeToggle from '@/components/location/FeedScopeToggle';
import { useFeedScopeParams } from '@/hooks/useFeedScope';
import { useContentCities } from '@/hooks/useContentCities';
import { useMoney } from '@/hooks/useMoney';
import { formatZar } from '@/lib/money';

const JOB_TYPES = ['ALL', 'FULL_TIME', 'PART_TIME', 'ONCE_OFF', 'CONTRACT'];
const COMPENSATION_TYPES = ['ALL', 'FIXED', 'NEGOTIABLE', 'UNPAID_TRIAL'];

function toLabel(text) {
  return String(text || '').replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function spotsLeft(job) {
  return Math.max((job.totalSpots || 0) - (job.filledSpots || 0), 0);
}

function closingText(closingDate) {
  if (!closingDate) return null;
  const days = differenceInDays(new Date(closingDate), new Date());
  if (days < 0 || days > 7) return null;
  if (days === 0) return 'Closes today';
  return `Closes in ${days} day${days === 1 ? '' : 's'}`;
}

function compensationText(job, fmt = formatZar) {
  if (job.compensationPer === 'COMMISSION') return 'Commission based';
  if (job.compensationType === 'NEGOTIABLE') return 'Negotiable';
  if (job.compensationType === 'UNPAID_TRIAL') return 'Unpaid trial';
  if (job.compensationAmount) return `${fmt(job.compensationAmount)} per ${String(job.compensationPer || 'MONTH').toLowerCase()}`;
  return 'Compensation not specified';
}

function toAppliedSet(apps) {
  return new Set((apps || []).map((x) => x.jobPostingId));
}

export default function Jobs() {
  const money = useMoney();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('ALL');
  const [selectedCity, setSelectedCity] = useState('ALL');
  const [selectedCompensation, setSelectedCompensation] = useState('ALL');
  const scope = useFeedScopeParams();
  const { cities: contentCities } = useContentCities({
    source: 'jobs',
    countryCode: scope.feedScope === 'worldwide' ? null : scope.countryCode,
  });
  const cityOptions = ['ALL', ...contentCities];

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['public-jobs', selectedCity, selectedType, selectedCompensation, scope.key],
    queryFn: () => {
      const params = new URLSearchParams(scope.params);
      if (selectedCity !== 'ALL') {
        params.set('city', selectedCity);
        params.set('feed_scope', 'worldwide');
      }
      if (selectedType !== 'ALL') params.set('jobType', selectedType);
      if (selectedCompensation !== 'ALL') params.set('compensationType', selectedCompensation);
      return apiGet(`/api/jobs/public${params.toString() ? `?${params.toString()}` : ''}`, { skipAuth: false });
    },
  });

  const { data: myApplications = [] } = useQuery({
    queryKey: ['my-job-applications-lite'],
    queryFn: () => apiGet('/api/jobs/my-applications'),
    retry: false,
  });

  const appliedSet = useMemo(() => toAppliedSet(myApplications), [myApplications]);
  const filteredJobs = jobs.filter((job) => (
    (job.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (job.venue?.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  ));

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 40, paddingTop: 'env(safe-area-inset-top)', backgroundColor: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(16px)', borderBottom: '1px solid var(--sec-border)' }}>
        <div style={{ padding: 'var(--space-4) var(--space-6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--sec-text-primary)' }}>Jobs</h1>
            <FeedScopeToggle compact />
          </div>
          <div style={{ position: 'relative' }}>
            <Search size={18} strokeWidth={1.5} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }} />
            <input className="sec-input" placeholder="Search jobs..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ paddingLeft: 44, height: 48 }} />
          </div>
        </div>
        <div style={{ padding: '0 var(--space-6) var(--space-4)', display: 'grid', gap: 8 }}>
          <select className="sec-input" style={{ height: 44 }} value={selectedCity} onChange={(e) => setSelectedCity(e.target.value)}>
            {cityOptions.map((x) => <option key={x} value={x}>{x === 'ALL' ? 'All cities' : x}</option>)}
          </select>
          <select className="sec-input" style={{ height: 44 }} value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
            {JOB_TYPES.map((x) => <option key={x} value={x}>{x === 'ALL' ? 'All job types' : toLabel(x)}</option>)}
          </select>
          <select className="sec-input" style={{ height: 44 }} value={selectedCompensation} onChange={(e) => setSelectedCompensation(e.target.value)}>
            {COMPENSATION_TYPES.map((x) => <option key={x} value={x}>{x === 'ALL' ? 'All compensation' : toLabel(x)}</option>)}
          </select>
        </div>
      </header>
      <div style={{ padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {myApplications.length > 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--sec-text-muted)',
              lineHeight: 1.5,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--sec-border)',
              backgroundColor: 'var(--sec-bg-card)',
            }}
          >
            Active applications: review the{' '}
            <LegalDocLink pageName="PromoterCodeOfConduct">Promoter Code of Conduct</LegalDocLink>
            {' '}and{' '}
            <LegalDocLink pageName="CommunityGuidelines">Community Guidelines</LegalDocLink>.
          </div>
        )}
        {filteredJobs.map((job, index) => (
          <motion.div key={job.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
            <Link to={createPageUrl(`JobDetails?id=${job.id}`)} className="sec-card block rounded-xl p-4 transition-colors group">
              <div className="flex items-start gap-4">
                <div style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Briefcase size={24} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {job.title}
                        {job.positionRole === 'PROMOTER' ? (
                          <span className="sec-badge" style={{ fontSize: 10, color: 'var(--sec-accent)' }}>Promoter</span>
                        ) : null}
                      </h3>
                      <div style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginTop: 4 }}>{job.venue?.name} · {toLabel(job.venue?.venueType)}</div>
                    </div>
                    <ChevronRight size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12, fontSize: 13, color: 'var(--sec-text-muted)' }}>
                    {job.venue?.city ? <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{job.venue.city}</span> : null}
                    {job.closingDate ? <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{new Date(job.closingDate).toLocaleDateString()}</span> : null}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <span className="sec-badge sec-badge-gold">{toLabel(job.jobType)}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--sec-text-muted)' }}>{spotsLeft(job)} spots left</span>
                  </div>
                  <p style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: 'var(--sec-accent)' }}>{compensationText(job, money.format)}</p>
                  {closingText(job.closingDate) ? <p style={{ marginTop: 8, fontSize: 12, color: 'var(--sec-warning)' }}>{closingText(job.closingDate)}</p> : null}
                  <p style={{ marginTop: 8, fontSize: 12, color: 'var(--sec-text-muted)' }}>{String(job.description || '').slice(0, 100)}</p>
                  <div style={{ marginTop: 10 }}>{appliedSet.has(job.id) ? <span className="sec-badge sec-badge-success">Applied</span> : <span className="sec-badge sec-badge-muted">Apply</span>}</div>
                </div>
              </div>
            </Link>
          </motion.div>
        ))}
        {filteredJobs.length === 0 && !isLoading ? (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Briefcase size={32} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--sec-text-primary)' }}>No jobs available</h3>
            <p style={{ color: 'var(--sec-text-muted)' }}>Check back soon for new opportunities</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}