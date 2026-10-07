import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiPost } from '@/api/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import MenuPicker, { menuSelectionToPayload, menuSelectionTotal } from '@/components/menu/MenuPicker';
import { SERVICE_FEE_ZAR, totalWithServiceFee } from '@/lib/serviceFee';
import { launchPaystackInline } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import { addonOrdersQueryKey } from '@/components/orders/AddonOrdersList';

/**
 * "Order more" after a ticket, entrance pass or table booking. Each payment becomes a separate
 * venue order with its own order-only QR.
 */
export default function OrderMoreDialog({ open, onOpenChange, ticketId = null, hostedTableId = null, email = null }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState({});
  const [paying, setPaying] = useState(false);
  const params = new URLSearchParams();
  if (ticketId) params.set('ticket_id', ticketId);
  if (hostedTableId) params.set('hosted_table_id', hostedTableId);

  const { data, isLoading } = useQuery({
    queryKey: ['addon-menu', ticketId || null, hostedTableId || null],
    queryFn: () => apiGet(`/api/orders/addons/menu?${params.toString()}`),
    enabled: open && Boolean(ticketId || hostedTableId),
    staleTime: 30_000,
  });
  const menu = data?.menu_items || [];
  const subtotal = menuSelectionTotal(menu, selected);

  const pay = async () => {
    const payload = menuSelectionToPayload(menu, selected);
    if (!payload.length) {
      toast.error('Select at least one item');
      return;
    }
    setPaying(true);
    try {
      const r = await apiPost('/api/orders/addons/initialize', {
        ticket_id: ticketId || undefined,
        hosted_table_id: hostedTableId || undefined,
        selected_menu_items: payload.map((p) => ({ menuItemId: p.menuItemId, quantity: p.quantity })),
      });
      if (!r?.reference || !r?.access_code) throw new Error('Could not start payment');
      await launchPaystackInline({
        email: r.email || email,
        amount: Number(r.amount_zar || 0),
        reference: r.reference,
        accessCode: r.access_code,
        authorizationUrl: r.authorization_url,
        onSuccess: async (payloadRef) => {
          await completePaystackCheckout({ reference: r.reference, payload: payloadRef, queryClient, showToasts: false });
          queryClient.invalidateQueries({ queryKey: addonOrdersQueryKey({ ticketId, hostedTableId }) });
          queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
          setSelected({});
          onOpenChange(false);
          toast.success('Add-on order paid — show its QR to staff to collect it.');
        },
      });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not place the order');
    } finally {
      setPaying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#0A0A0B] border-[#262629] max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Order more</DialogTitle>
          <DialogDescription>
            {data?.parent?.venue_name ? `${data.parent.venue_name} · ` : ''}
            Each order is paid separately and gets its own QR for staff. It does not change your entry pass.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-gray-500 py-6 text-center">Loading menu…</p>
        ) : data && !data.eligible ? (
          <p className="text-sm text-amber-200/90 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
            {data.reason || 'You cannot order more on this booking right now.'}
          </p>
        ) : menu.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">This venue has no menu items available right now.</p>
        ) : (
          <>
            <MenuPicker items={menu} selected={selected} onChange={(id, qty) => setSelected((s) => ({ ...s, [id]: qty }))} />
            <Button className="w-full mt-3 bg-[var(--sec-accent)] text-black" disabled={paying || subtotal <= 0} onClick={pay}>
              {subtotal > 0
                ? `Pay R${totalWithServiceFee(subtotal).toFixed(2)} (incl. R${SERVICE_FEE_ZAR} service fee)`
                : 'Select items to order'}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
