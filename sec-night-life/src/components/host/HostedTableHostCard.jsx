import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { MessageCircle, Copy, UserPlus, Camera, Sparkles, Trash2 } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { hostedListingDetailsPath, hostedListingSettingsLabel } from '@/lib/hostedListingUrl';
import { useMoney } from '@/hooks/useMoney';

const TABLE_HOST_STATUS_BADGE = {
  DRAFT: { label: 'Awaiting listing payment', bg: 'var(--sec-warning-muted)', color: 'var(--sec-text-primary)' },
  ACTIVE: { label: 'Live', bg: 'var(--sec-success-muted)', color: 'var(--sec-text-primary)' },
  FULL: { label: 'Full', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' },
  CLOSED: { label: 'Closed', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' },
  REFUNDED: { label: 'Refunded', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' },
};

const PROMOTED_BORDER = 'var(--sec-accent-border)';
const PROMOTED_BADGE_CLASS =
  'text-[10px] px-2 py-0.5 rounded-full font-semibold inline-flex items-center gap-1 text-black';
const PROMOTED_BADGE_STYLE = {
  background: 'var(--sec-gradient-silver)',
  border: '1px solid var(--sec-accent-border)',
};

/**
 * Host-facing hosted table card for My tables tab.
 */
export default function HostedTableHostCard({
  table: t,
  hostStatusBadge,
  loc,
  manageTableId,
  inviteOpenTableId,
  pendingTableId,
  rulesForm,
  setRulesForm,
  savingRules,
  onSaveRules,
  onManageToggle,
  onInviteToggle,
  onCopyLink,
  onOpenGroupChat,
  onBoost,
  onPayListing,
  onReviewToggle,
  onPhotoInputChange,
  onDelete,
  photoPreviewUrl,
  childrenPending,
  childrenInvite,
  isPast = false,
}) {
  const money = useMoney();
  const [deleting, setDeleting] = useState(false);
  const settingsLabel = hostedListingSettingsLabel(t);
  const detailsHref = hostedListingDetailsPath(t);
  const badge = t.hostRefundStatus === 'REFUNDED'
    ? TABLE_HOST_STATUS_BADGE.REFUNDED
    : isPast
      ? { label: 'Past', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' }
      : hostStatusBadge || TABLE_HOST_STATUS_BADGE[t.status] || TABLE_HOST_STATUS_BADGE.DRAFT;
  const isManaging = !isPast && t.hostRefundStatus !== 'REFUNDED' && manageTableId === t.id;
  const canDelete = isPast || t.status === 'CLOSED' || t.hostRefundStatus === 'REFUNDED';

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete(t.id);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article
      className="sec-card overflow-hidden rounded-2xl border border-[var(--sec-border)] bg-[var(--sec-bg-card)] shadow-sm"
      style={t.boosted ? { borderColor: PROMOTED_BORDER, boxShadow: '0 4px 24px rgba(192, 192, 192, 0.08)' } : undefined}
    >
      <div className="relative h-36 bg-[var(--sec-bg-elevated)]">
        {photoPreviewUrl || t.photo ? (
          <img src={photoPreviewUrl || t.photo} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-[var(--sec-text-muted)]">
            <Camera className="w-8 h-8 opacity-40" />
            <span className="text-xs">Add a cover photo for group chat & discovery</span>
          </div>
        )}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: badge.bg, color: badge.color }}>
            {badge.label}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/20 bg-black/50 text-white">
            {t.isPublic ? 'Public' : 'Private'}
          </span>
          {(t.pendingInviteCount ?? 0) > 0 && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-medium text-black"
              style={{ background: 'var(--sec-accent)', border: '1px solid var(--sec-accent-border)' }}
            >
              {t.pendingInviteCount} invite{t.pendingInviteCount === 1 ? '' : 's'} pending
            </span>
          )}
        </div>
        {t.boosted ? (
          <span className={`absolute top-2 left-2 ${PROMOTED_BADGE_CLASS}`} style={PROMOTED_BADGE_STYLE}>
            <Sparkles className="w-3 h-3" /> Promoted
          </span>
        ) : null}
      </div>

      <div className="p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-lg leading-tight">{t.tableName || t.venueName}</h3>
          <p className="text-xs text-[var(--sec-text-muted)] mt-1 line-clamp-2">{loc}</p>
        </div>

        <p className="text-xs text-[var(--sec-text-muted)]">
          {format(parseISO(t.eventDate), 'EEE d MMM')} · {t.eventTime}
          {t.eventEndDate || t.eventEndTime || t.windowEndsAt
            ? ` → ${
                t.eventEndDate
                  ? format(parseISO(t.eventEndDate), 'EEE d MMM')
                  : t.windowEndsAt
                    ? format(
                        typeof t.windowEndsAt === 'string' ? parseISO(t.windowEndsAt) : new Date(t.windowEndsAt),
                        'EEE d MMM',
                      )
                    : ''
              } · ${t.eventEndTime || (t.windowEndsAt
                ? format(
                    typeof t.windowEndsAt === 'string' ? parseISO(t.windowEndsAt) : new Date(t.windowEndsAt),
                    'HH:mm',
                  )
                : '')}`
            : ''}{' '}
          ·{' '}
          {t.tableType === 'EXTERNAL_VENUE' && !t.eventId
            ? t.listingSurface === 'EVENT'
              ? 'Your own event'
              : 'Your own table'
            : !t.eventId
              ? 'Day booking'
              : t.tableType === 'IN_APP_EVENT'
                ? 'SEC event'
                : 'External meet-up'}
        </p>

        {t.tableDescription ? (
          <p className="text-sm text-[var(--sec-text-secondary)] line-clamp-2">{t.tableDescription}</p>
        ) : null}

        <div className="flex flex-wrap gap-2 text-sm">
          <Link
            to={detailsHref}
            className="px-2.5 py-1 rounded-lg bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] hover:border-[var(--sec-accent-border)] transition-colors"
          >
            {t.listingSurface === 'EVENT' ? 'Going' : 'Members'}{' '}
            {t.memberCount ?? t._count?.members ?? 0}
          </Link>
          {t.hostFeePaystackRef ? (
            <Link
              to={createPageUrl('Profile?tab=tickets')}
              className="px-2.5 py-1 rounded-lg bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] hover:border-[var(--sec-accent-border)] transition-colors"
            >
              View QR
            </Link>
          ) : null}
          <span className="px-2.5 py-1 rounded-lg bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)]">
            Spots left {t.spotsRemaining}
          </span>
          {t.hasJoiningFee ? (
            <span
              className="px-2.5 py-1 rounded-lg"
              style={{
                color: 'var(--sec-accent-bright)',
                border: '1px solid var(--sec-accent-border)',
                background: 'var(--sec-accent-muted)',
              }}
            >
              {money.format(t.joiningFee || 0)} join
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {!isPast && t.status === 'DRAFT' && t.tableType === 'EXTERNAL_VENUE' && (
            <button type="button" className="sec-btn sec-btn-primary text-xs py-2 px-3 rounded-xl" onClick={() => onPayListing?.(t.id)}>
              Pay listing & go live
            </button>
          )}
          {!isPast && t.status === 'DRAFT' && t.tableType === 'IN_APP_EVENT' && (
            <p className="text-xs text-[var(--sec-text-muted)] w-full">
              Book a venue table from the event or day booking page to host — this draft listing checkout is no longer available.
            </p>
          )}
          {t.groupChat?.id && (
            <Link
              to={`${createPageUrl('Messages')}?group=${encodeURIComponent(t.groupChat.id)}&gk=HOSTED_TABLE`}
              className="inline-flex items-center gap-1.5 text-xs sec-btn sec-btn-secondary py-2 px-3 rounded-xl"
              onClick={onOpenGroupChat}
            >
              <MessageCircle className="w-4 h-4" />
              Group chat
            </Link>
          )}
          {!isPast && t.status === 'ACTIVE' && (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs sec-btn sec-btn-secondary py-2 px-3 rounded-xl"
                onClick={() => onCopyLink?.(t.id)}
              >
                <Copy className="w-4 h-4" />
                Copy link
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs sec-btn sec-btn-ghost py-2 px-3 rounded-xl border border-[var(--sec-border)]"
                onClick={() => onInviteToggle?.(t.id)}
              >
                <UserPlus className="w-4 h-4" />
                {inviteOpenTableId === t.id ? 'Hide invite' : 'Invite'}
              </button>
              <button
                type="button"
                className="text-xs sec-btn sec-btn-secondary py-2 px-3 rounded-xl"
                onClick={() => onManageToggle?.(t)}
              >
                {isManaging ? 'Close settings' : settingsLabel}
              </button>
              {(t.pendingJoinCount ?? 0) > 0 && (
                <button
                  type="button"
                  className="text-xs sec-btn sec-btn-ghost py-2 px-3 rounded-xl border border-[var(--sec-border)]"
                  onClick={() => onReviewToggle?.(t.id)}
                >
                  {pendingTableId === t.id ? 'Hide requests' : 'Review requests'}
                </button>
              )}
            </>
          )}
          {canDelete && onDelete ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 text-xs sec-btn sec-btn-ghost py-2 px-3 rounded-xl border border-[var(--sec-border)] text-[var(--sec-error)]"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent
                className="border-[var(--sec-border)]"
                style={{ background: 'var(--sec-bg-card)', color: 'var(--sec-text-primary)' }}
              >
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete this {t.listingSurface === 'EVENT' ? 'event' : 'table'}?
                  </AlertDialogTitle>
                  <AlertDialogDescription style={{ color: 'var(--sec-text-muted)' }}>
                    This removes the listing from your dashboard. Group chat history may still exist for people who
                    joined.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-[var(--sec-border)]">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deleting}
                    onClick={handleDelete}
                    className="bg-[var(--sec-error)] text-white hover:opacity-90"
                  >
                    {deleting ? 'Deleting…' : t.listingSurface === 'EVENT' ? 'Delete event' : 'Delete table'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>

        {!isPast && t.status === 'DRAFT' && t.tableType === 'EXTERNAL_VENUE' && (
          <p className="text-xs text-[var(--sec-text-muted)] leading-relaxed">
            Not visible until listing payment succeeds. Then your group chat opens and you can invite guests.
          </p>
        )}

        {!isPast && t.status === 'ACTIVE' && isManaging && (
          <div className="rounded-xl border border-[var(--sec-accent-border)] bg-[var(--sec-bg-elevated)] p-4 space-y-4">
            <p className="text-sm font-semibold">{settingsLabel}</p>
            <div>
              <label className="text-xs text-[var(--sec-text-muted)] block mb-2">
                Table photo — group chat avatar, browse cards, and Home when boosted
              </label>
              <input type="file" accept="image/*" className="sec-input-rect w-full text-xs" onChange={onPhotoInputChange} />
              {photoPreviewUrl || t.photo ? (
                <p className="text-[11px] text-[var(--sec-text-muted)] mt-2">Save settings to apply a new photo.</p>
              ) : null}
            </div>
            <div>
              <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Name (updates group chat)</label>
              <Input
                value={rulesForm.tableName}
                onChange={(e) => setRulesForm((f) => ({ ...f, tableName: e.target.value }))}
                className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                maxLength={60}
              />
            </div>
            {t.tableType === 'EXTERNAL_VENUE' && !t.venueTableId && !t.eventId ? (
              <div className="space-y-3">
                <p className="text-xs text-[var(--sec-text-muted)]">
                  Edit start and end schedule. QR codes expire at the end date and time.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Start date</label>
                    <Input
                      type="date"
                      value={rulesForm.eventDate || ''}
                      onChange={(e) => setRulesForm((f) => ({ ...f, eventDate: e.target.value }))}
                      className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Start time</label>
                    <Input
                      type="time"
                      value={rulesForm.eventTime || ''}
                      onChange={(e) => setRulesForm((f) => ({ ...f, eventTime: e.target.value }))}
                      className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--sec-text-muted)] block mb-1">End date</label>
                    <Input
                      type="date"
                      value={rulesForm.eventEndDate || ''}
                      min={rulesForm.eventDate || undefined}
                      onChange={(e) => setRulesForm((f) => ({ ...f, eventEndDate: e.target.value }))}
                      className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--sec-text-muted)] block mb-1">End time</label>
                    <Input
                      type="time"
                      value={rulesForm.eventEndTime || ''}
                      onChange={(e) => setRulesForm((f) => ({ ...f, eventEndTime: e.target.value }))}
                      className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                    />
                  </div>
                </div>
              </div>
            ) : null}
            {t.tableType === 'IN_APP_EVENT' && (
              <>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={rulesForm.isPublic}
                    onChange={(e) => setRulesForm((f) => ({ ...f, isPublic: e.target.checked }))}
                  />
                  <span>
                    <span className="font-medium">Public table (anyone can join without approval)</span>
                    <span className="block text-xs text-[var(--sec-text-muted)] mt-0.5">
                      When off, the table stays on Home but guests must request approval to join.
                    </span>
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rulesForm.hasJoiningFee}
                    onChange={(e) => setRulesForm((f) => ({ ...f, hasJoiningFee: e.target.checked }))}
                  />
                  Charge a joining fee
                </label>
                {rulesForm.hasJoiningFee ? (
                  <div>
                    <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Joining fee (ZAR, min R10)</label>
                    <Input
                      type="number"
                      min={10}
                      value={rulesForm.joiningFee}
                      onChange={(e) => setRulesForm((f) => ({ ...f, joiningFee: e.target.value }))}
                      className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
                    />
                  </div>
                ) : null}
              </>
            )}
            <button
              type="button"
              disabled={savingRules}
              className="sec-btn sec-btn-primary text-sm py-2 px-4 rounded-xl w-full"
              onClick={() => onSaveRules?.(t)}
            >
              {savingRules ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        )}

        {childrenInvite}
        {childrenPending}

        {!isPast && !t.boosted && t.status === 'ACTIVE' ? (
          <button type="button" className="sec-btn sec-btn-secondary text-xs w-full py-2.5 rounded-xl" onClick={() => onBoost?.(t.id)}>
            Boost on Home & Discover (R150/day)
          </button>
        ) : t.boosted ? (
          <p className="text-xs text-center" style={{ color: 'var(--sec-accent-bright)' }}>
            Promoted on Home and For You Discover
          </p>
        ) : null}
      </div>
    </article>
  );
}
