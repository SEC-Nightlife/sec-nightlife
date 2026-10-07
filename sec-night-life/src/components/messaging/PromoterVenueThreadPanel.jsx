import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/api/client';
import { createPageUrl } from '@/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ChevronLeft, MessageSquareX, Megaphone } from 'lucide-react';
import { markConversationReadInCaches } from '@/lib/messagesRefresh';
import { useMessageReply } from '@/hooks/useMessageReply';
import MessageBubble from '@/components/messaging/MessageBubble';
import MessageReplyPreview from '@/components/messaging/MessageReplyPreview';
import ChatComposer from '@/components/messaging/ChatComposer';
import { linkifyMessageBody } from '@/lib/linkifyMessageBody';

const PROMOTIONS_URL = `${createPageUrl('Profile')}?tab=promotions`;

export default function PromoterVenueThreadPanel({
  threadId,
  onClose,
  onDeleted,
  isBusiness = false,
  hideHeader = false,
}) {
  const [sending, setSending] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);
  const [messageBody, setMessageBody] = useState('');
  const { replyingTo, setReplyingTo, clearReply } = useMessageReply();

  const { data, refetch, isSuccess } = useQuery({
    queryKey: ['promoter-venue-thread', threadId],
    queryFn: () => apiGet(`/api/promoter-venue-threads/${threadId}/messages`),
    enabled: !!threadId,
    refetchInterval: 15000,
  });

  const messages = data?.messages || [];
  const thread = data?.thread;
  const assignments = data?.assignments || [];

  useEffect(() => {
    if (isSuccess && threadId) markConversationReadInCaches('promoter_venue', threadId);
  }, [isSuccess, threadId, messages.length]);

  async function deleteChat() {
    if (!window.confirm('Delete this chat? It will be removed from your messages.')) return;
    setDeletingChat(true);
    try {
      await apiDelete(`/api/promoter-venue-threads/${threadId}`);
      toast.success('Chat deleted');
      if (onDeleted) onDeleted();
      else onClose();
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not delete chat');
    } finally {
      setDeletingChat(false);
    }
  }

  async function sendMessage() {
    if (!messageBody.trim()) return;
    setSending(true);
    try {
      await apiPost(`/api/promoter-venue-threads/${threadId}/messages`, {
        body: messageBody.trim(),
        ...(replyingTo?.id ? { replyToMessageId: replyingTo.id } : {}),
      });
      setMessageBody('');
      clearReply();
      await refetch();
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not send');
    } finally {
      setSending(false);
    }
  }

  const headerTitle = isBusiness
    ? thread?.promoterUsername || thread?.promoterName || 'Promoter'
    : thread?.venueName || 'Venue';

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--sec-bg-base)]">
      {!hideHeader ? (
        <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--sec-border)] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--sec-bg-elevated)' }}
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <h2 className="font-semibold text-sm flex-1 truncate">{headerTitle}</h2>
          <button
            type="button"
            onClick={deleteChat}
            disabled={deletingChat}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--sec-text-muted)] hover:text-red-400"
            title="Delete chat"
          >
            <MessageSquareX size={16} />
          </button>
        </header>
      ) : null}

      {assignments.length > 0 ? (
        <div className="px-4 py-3 border-b border-[var(--sec-border)] bg-[var(--sec-bg-elevated)] shrink-0">
          <p className="text-xs font-semibold mb-2 flex items-center gap-1">
            <Megaphone size={12} /> Assigned events
          </p>
          <ul className="space-y-1">
            {assignments.map((a) => (
              <li key={a.eventId}>
                <Link
                  to={createPageUrl(`EventDetails?id=${a.eventId}`)}
                  className="text-xs text-[var(--sec-accent)] underline break-all"
                >
                  {a.title}
                  {a.date ? ` · ${new Date(a.date).toLocaleDateString(undefined, { timeZone: 'UTC' })}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
        {messages.length === 0 ? (
          <p className="text-sm text-[var(--sec-text-muted)]">
            {isBusiness
              ? 'Message your promoter here. Event assignments appear automatically.'
              : 'Event assignments and messages from the venue appear here.'}
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              onReply={setReplyingTo}
              className="text-sm p-3 rounded-xl max-w-[min(90%,calc(100vw-3rem))] min-w-0"
              style={{
                marginLeft: m.isMine ? 'auto' : 0,
                background: m.kind === 'ASSIGNMENT'
                  ? 'rgba(234, 179, 8, 0.12)'
                  : m.isMine
                    ? 'var(--sec-accent-muted)'
                    : 'var(--sec-bg-elevated)',
                border: '1px solid var(--sec-border)',
              }}
            >
              <div className="text-[10px] text-[var(--sec-text-muted)] mb-1">{m.senderLabel}</div>
              <div>{linkifyMessageBody(m.body)}</div>
              {m.kind === 'ASSIGNMENT' && m.eventId && !m.eventEnded && !isBusiness ? (
                <Link
                  to={PROMOTIONS_URL}
                  className="text-xs text-[var(--sec-accent)] underline mt-2 inline-block"
                >
                  Open promotions
                </Link>
              ) : null}
            </MessageBubble>
          ))
        )}
      </div>

      <ChatComposer
        value={messageBody}
        onChange={setMessageBody}
        onSend={sendMessage}
        disabled={sending}
        placeholder={isBusiness ? 'Message promoter…' : 'Message venue…'}
        replyPreview={
          <MessageReplyPreview replyingTo={replyingTo} onClear={clearReply} />
        }
      />
    </div>
  );
}
