import React, { useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '@/api/client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AdminEmptyState from './AdminEmptyState';

export default function AdminReportsPanel() {
  const [reports, setReports] = useState([]);
  const [reportFilters, setReportFilters] = useState({ status: 'pending', priority: '', category: '' });
  const [reportResolutionNotes, setReportResolutionNotes] = useState({});
  const [actionLoading, setActionLoading] = useState(null);

  const loadReports = async (filters = reportFilters) => {
    try {
      const qs = new URLSearchParams({ status: filters.status || 'pending', limit: '100' });
      if (filters.priority) qs.set('priority', filters.priority);
      if (filters.category) qs.set('category', filters.category);
      const res = await apiGet(`/api/admin/reports?${qs.toString()}`);
      setReports(res?.reports || []);
    } catch (err) {
      setReports([]);
      toast.error(`Could not load reports${err?.message ? `: ${err.message}` : ''}`);
    }
  };

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveReport = async (reportId, action) => {
    const resolutionNote = (reportResolutionNotes[reportId] || '').trim();
    if (resolutionNote.length < 3) {
      toast.error('Please enter a resolution note (at least 3 characters).');
      return;
    }
    setActionLoading(`report-${reportId}-${action}`);
    try {
      await apiPatch(`/api/admin/reports/${reportId}/resolve`, { action, resolutionNote });
      await loadReports();
      toast.success('Report updated');
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Failed to resolve report');
    } finally {
      setActionLoading(null);
    }
  };

  const moderateFromReport = async (reportId, moderationAction) => {
    const reason = (reportResolutionNotes[reportId] || '').trim();
    if (reason.length < 3) {
      toast.error('Please enter an action reason (at least 3 characters).');
      return;
    }
    setActionLoading(`report-moderate-${reportId}`);
    try {
      await apiPost(`/api/admin/reports/${reportId}/moderate`, { action: moderationAction, reason });
      await loadReports();
      toast.success('Moderation action completed');
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Moderation action failed');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          className="p-2 rounded-lg bg-[#0A0A0B] border border-[#262629] text-sm min-h-[44px]"
          value={reportFilters.status}
          onChange={async (e) => {
            const next = { ...reportFilters, status: e.target.value };
            setReportFilters(next);
            await loadReports(next);
          }}
        >
          <option value="pending">Pending</option>
          <option value="in_review">In review</option>
          <option value="action_taken">Action taken</option>
          <option value="dismissed">Dismissed</option>
          <option value="resolved">Resolved</option>
        </select>
        <select
          className="p-2 rounded-lg bg-[#0A0A0B] border border-[#262629] text-sm min-h-[44px]"
          value={reportFilters.priority}
          onChange={async (e) => {
            const next = { ...reportFilters, priority: e.target.value };
            setReportFilters(next);
            await loadReports(next);
          }}
        >
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      {reports.length === 0 ? (
        <AdminEmptyState message="No reports in this view." />
      ) : (
        reports.map((r) => (
          <div key={r.id} className="p-4 rounded-xl bg-[#141416] border border-[#262629] space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium capitalize">
                  {r.targetType} report · {r.category?.replace(/_/g, ' ') || 'other'}
                </p>
                <p className="text-xs text-[var(--sec-text-muted)]">
                  Reported by {r.reporter?.email || 'Unknown'} · {new Date(r.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="text-xs px-2 py-1 rounded-full border border-[#3a3a3e]">
                {r.priority}
              </div>
            </div>
            <p className="text-sm">{r.reason}</p>
            {r.details && <p className="text-xs text-[var(--sec-text-muted)] whitespace-pre-wrap">{r.details}</p>}
            {!!r.evidenceUrls?.length && (
              <div className="text-xs text-[var(--sec-text-muted)]">
                Evidence: {r.evidenceUrls.length} link(s)
              </div>
            )}

            <textarea
              value={reportResolutionNotes[r.id] || ''}
              onChange={(e) => setReportResolutionNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
              className="w-full p-2 rounded-lg bg-[#0A0A0B] border border-[#262629] text-sm"
              rows={2}
              placeholder="Feedback for the reporter (and suspend reason if suspending). Required — they will see this note."
            />

            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!actionLoading}
                onClick={() => resolveReport(r.id, 'dismissed')}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                disabled={!!actionLoading}
                onClick={() => resolveReport(r.id, 'action_taken')}
              >
                Mark action taken
              </Button>
              {r.targetType === 'user' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500/50 text-red-400"
                    disabled={!!actionLoading}
                    onClick={() => moderateFromReport(r.id, 'suspend_user')}
                  >
                    Suspend user
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!actionLoading}
                    onClick={() => moderateFromReport(r.id, 'unsuspend_user')}
                  >
                    Unsuspend user
                  </Button>
                </>
              )}
              {r.targetType === 'venue' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/50 text-red-400"
                  disabled={!!actionLoading}
                  onClick={() => moderateFromReport(r.id, 'reject_venue')}
                >
                  Reject venue compliance
                </Button>
              )}
              {r.targetType === 'event' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/50 text-red-400"
                  disabled={!!actionLoading}
                  onClick={() => moderateFromReport(r.id, 'cancel_event')}
                >
                  Cancel event
                </Button>
              )}
              {r.targetType === 'vendor' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500/50 text-red-400"
                    disabled={!!actionLoading}
                    onClick={() => moderateFromReport(r.id, 'unpublish_vendor')}
                  >
                    Unpublish vendor listing
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!actionLoading}
                    onClick={() => moderateFromReport(r.id, 'republish_vendor')}
                  >
                    Restore listing
                  </Button>
                  <a
                    href={`/VendorDetail?id=${encodeURIComponent(r.targetId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline self-center"
                  >
                    View listing
                  </a>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
