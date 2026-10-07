import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { QrCode, ShoppingBag } from 'lucide-react';
import { apiGet } from '@/api/client';
import { resolveTicketVerifyUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import TicketQrBlock from '@/components/tickets/TicketQrBlock';

export function addonOrdersQueryKey({ ticketId, hostedTableId }) {
  return ['addon-orders', ticketId || null, hostedTableId || null];
}

function statusLabel(addon) {
  if (addon.status === 'REFUNDED') return { text: 'Refunded', cls: 'sec-badge-muted' };
  if (addon.fulfilled) return { text: 'Served', cls: 'sec-badge-success' };
  return { text: 'Paid — waiting to be served', cls: 'sec-badge-gold' };
}

/** Add-on orders already placed on one ticket or table, each with its own order-only QR. */
export default function AddonOrdersList({ ticketId = null, hostedTableId = null, className = '' }) {
  const [openQr, setOpenQr] = useState(null);
  const params = new URLSearchParams();
  if (ticketId) params.set('ticket_id', ticketId);
  if (hostedTableId) params.set('hosted_table_id', hostedTableId);
  const { data } = useQuery({
    queryKey: addonOrdersQueryKey({ ticketId, hostedTableId }),
    queryFn: () => apiGet(`/api/orders/addons/mine?${params.toString()}`),
    enabled: Boolean(ticketId || hostedTableId),
    staleTime: 15_000,
  });
  const addons = data?.addons || [];
  if (!addons.length) return null;

  return (
    <div className={`space-y-2 ${className}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Add-on orders</p>
      {addons.map((a) => {
        const st = statusLabel(a);
        const verifyUrl = a.ticket?.qr_token ? resolveTicketVerifyUrl({ qr_token: a.ticket.qr_token }) : null;
        const showQr = openQr === a.id;
        return (
          <div key={a.id} className="rounded-lg border border-[#262629] bg-[#0A0A0B] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="text-sm text-white flex items-center gap-1.5">
                  <ShoppingBag className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                  <span className="break-words">{a.items_summary || 'Menu items'}</span>
                </p>
                <p className="text-xs text-gray-500">
                  R{Number(a.total_zar || 0).toFixed(2)}
                  {a.paid_at ? ` · ${format(parseISO(a.paid_at), 'MMM d, HH:mm')}` : ''}
                </p>
                <span className={`sec-badge ${st.cls} text-[10px] inline-block`}>{st.text}</span>
              </div>
              {verifyUrl && a.status !== 'REFUNDED' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-[#262629] h-8 shrink-0"
                  onClick={() => setOpenQr(showQr ? null : a.id)}
                >
                  <QrCode className="w-3.5 h-3.5 mr-1" />
                  {showQr ? 'Hide QR' : 'Order QR'}
                </Button>
              )}
            </div>
            {showQr && verifyUrl && (
              <div className="mt-3 flex flex-col items-center gap-1">
                <TicketQrBlock verifyUrl={verifyUrl} compact />
                <p className="text-[10px] text-gray-400 text-center max-w-[14rem]">
                  Show this to staff to collect your order. It does not admit entry — use your main pass at the door.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
