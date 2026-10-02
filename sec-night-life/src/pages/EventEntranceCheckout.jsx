import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/api/client';
import * as authService from '@/services/authService';
import { createPageUrl, getStoredPromoterRef } from '@/utils';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { menuSelectionTotal, menuSelectionToPayload } from '@/components/menu/MenuPicker';
import VenueMenuBrowser from '@/components/menu/VenueMenuBrowser';
import MenuCheckoutLines from '@/components/checkout/MenuCheckoutLines';
import RefundPolicyNote from '@/components/legal/RefundPolicyNote';
import { launchPaystackInline, loadPaystackScript } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import { Loader2, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { isEventEnded } from '@/lib/eventLifecycle';
import { SERVICE_FEE_LABEL, serviceFeeForSubtotal, totalWithServiceFee } from '@/lib/serviceFee';

export default function EventEntranceCheckout() {
  const [params] = useSearchParams();
  const eventId = params.get('id') || params.get('event_id');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuSelected, setMenuSelected] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);

  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => apiGet(`/api/events/${eventId}`),
    enabled: Boolean(eventId),
  });

  const venueId = event?.venue_id;
  const { data: venueMenu = [], isLoading: menuLoading } = useQuery({
    queryKey: ['venue-menu-public', venueId],
    queryFn: () => apiGet(`/api/business/venues/${venueId}/menu-items/public`),
    enabled: Boolean(venueId),
  });

  useEffect(() => {
    loadPaystackScript().catch(() => {});
  }, []);

  const entranceZar = Number(event?.entrance_fee_amount) || 0;
  const menuSubtotal = menuSelectionTotal(venueMenu, menuSelected);
  const subtotalPrice = Math.round((entranceZar + menuSubtotal) * 100) / 100;
  const serviceFee = serviceFeeForSubtotal(subtotalPrice);
  const totalPrice = totalWithServiceFee(subtotalPrice);

  const handlePay = async () => {
    if (!eventId || !event) return;
    if (!event.has_entrance_fee) {
      toast.error('This event does not have an entrance fee');
      return;
    }
    if (window.self !== window.top) {
      toast.error('Checkout only works from the published app, not in preview mode');
      return;
    }
    setIsProcessing(true);
    try {
      const { user } = await authService.resolveUserForAction(window.location.href);
      const menuPayload = menuSelectionToPayload(venueMenu, menuSelected);
      const promoterRef = getStoredPromoterRef(eventId);

      if (totalPrice <= 0) {
        const body = {};
        if (menuPayload.length > 0) body.selected_menu_items = menuPayload;
        if (promoterRef) body.promoter_user_id = promoterRef;
        const res = await apiPost(`/api/events/${eventId}/claim-free-entrance`, body);
        if (!res?.confirmed) throw new Error(res?.error || 'Could not claim free entrance');
        queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
        queryClient.invalidateQueries({ queryKey: ['event', eventId] });
        toast.success('Free entrance confirmed. View your QR in Profile → Tickets.');
        navigate(`${createPageUrl('TicketSuccess')}?kind=entrance`);
        return;
      }

      const metadata = {
        type: 'EVENT_ENTRANCE',
        event_id: eventId,
        entrance_zar: entranceZar,
        menu_zar: menuSubtotal,
        amount_total_zar: totalPrice,
      };
      if (menuPayload.length > 0) metadata.selected_menu_items = menuPayload;
      if (promoterRef) metadata.promoter_user_id = promoterRef;

      const res = await apiPost('/api/payments/initialize', {
        amount: totalPrice,
        email: user?.email,
        description: `${event.title} — Entrance`,
        event_id: eventId,
        venue_id: venueId,
        metadata,
      });
      if (!res?.reference || !res?.access_code) throw new Error('No payment URL returned');

      await launchPaystackInline({
        email: user?.email,
        amount: totalPrice,
        reference: res.reference,
        accessCode: res.access_code,
        authorizationUrl: res.authorization_url,
        onSuccess: (payload) => {
          void completePaystackCheckout({ reference: res.reference, payload, queryClient });
          navigate(`${createPageUrl('TicketSuccess')}?kind=entrance`);
        },
        onCancel: () => toast.message('Checkout cancelled'),
      });
    } catch (error) {
      if (error?.name === 'AuthRequiredError') return;
      if (error?.code === 'SESSION_SOFT_FAIL') {
        toast.error('Still signing you in — try again in a moment.');
        return;
      }
      toast.error(error?.data?.error || error?.message || 'Failed to start checkout');
    } finally {
      setIsProcessing(false);
    }
  };

  if (!eventId) {
    return (
      <div className="sec-page">
        <PageBackHeader title="Pay to enter" />
        <p style={{ padding: 16, color: 'var(--sec-text-muted)' }}>Missing event.</p>
      </div>
    );
  }

  if (eventLoading) {
    return (
      <div className="sec-page" style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (event?.ended || isEventEnded(event)) {
    return (
      <div className="sec-page">
        <PageBackHeader title="Pay to enter" backTo={createPageUrl(`EventDetails?id=${eventId}`)} />
        <p style={{ padding: 16, color: 'var(--sec-text-muted)' }}>This event has ended. Entrance is no longer available.</p>
      </div>
    );
  }

  return (
    <div className="sec-page" style={{ paddingBottom: 120 }}>
      <PageBackHeader
        title={totalPrice <= 0 ? 'Free entrance' : 'Pay to enter'}
        backTo={createPageUrl(`EventDetails?id=${eventId}`)}
      />
      <div style={{ padding: '0 16px', maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--sec-text-primary)', marginBottom: 4 }}>
          {event?.title}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--sec-text-muted)', marginBottom: 20 }}>
          {totalPrice <= 0
            ? 'Claim your free entrance pass. You will get a QR code under Profile → Tickets.'
            : 'Pay the entrance fee to attend. You can still host or join a table later — entrance already paid will be credited.'}
        </p>

        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: 'var(--sec-text-primary)' }}>
          Add from the menu (optional)
        </h2>
        {menuLoading ? (
          <Loader2 className="animate-spin" style={{ marginBottom: 16 }} />
        ) : (
          <VenueMenuBrowser
            items={venueMenu}
            selected={menuSelected}
            onChange={(id, qty) => setMenuSelected((s) => ({ ...s, [id]: qty }))}
            hideStickyFooter
          />
        )}

        <div
          style={{
            background: 'var(--sec-bg-card)',
            border: '1px solid var(--sec-border)',
            borderRadius: 'var(--radius-lg)',
            padding: 16,
            marginTop: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: 'var(--sec-text-secondary)' }}>Entrance fee</span>
            <span style={{ fontWeight: 700, color: 'var(--sec-text-primary)' }}>
              {entranceZar <= 0 ? 'Free' : `R${entranceZar.toFixed(0)}`}
            </span>
          </div>
          <MenuCheckoutLines items={venueMenu} selected={menuSelected} />
          {serviceFee > 0 ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: 'var(--sec-text-secondary)' }}>{SERVICE_FEE_LABEL}</span>
              <span style={{ fontWeight: 700, color: 'var(--sec-text-primary)' }}>R{serviceFee.toFixed(2)}</span>
            </div>
          ) : null}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              borderTop: '1px solid var(--sec-border)',
              paddingTop: 10,
              marginTop: 4,
            }}
          >
            <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>Total</span>
            <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--sec-text-primary)' }}>
              R{totalPrice.toFixed(2)}
            </span>
          </div>
        </div>

        <RefundPolicyNote style={{ marginTop: 16 }} />
      </div>

      <div className="sec-bottom-bar sec-bottom-bar--responsive">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', maxWidth: 560, margin: '0 auto' }}>
          <div className="sec-bottom-bar__price">
            {menuSubtotal > 0 ? (
              <div style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginBottom: 2, lineHeight: 1.35, maxHeight: 72, overflow: 'auto' }}>
                Entrance {entranceZar <= 0 ? 'Free' : `R${entranceZar.toFixed(0)}`}
                {menuSelectionToPayload(venueMenu, menuSelected).map((line) => (
                  <div key={line.menuItemId}>
                    {line.name || 'Item'} ×{line.quantity} · R
                    {(Number(line.unitPrice || 0) * Number(line.quantity || 0)).toFixed(0)}
                  </div>
                ))}
                {serviceFee > 0 ? <div>{SERVICE_FEE_LABEL} · R{serviceFee.toFixed(2)}</div> : null}
              </div>
            ) : (
              <div className="sec-bottom-bar__price-label">
                {serviceFee > 0 ? `Total incl. R${serviceFee.toFixed(0)} service fee` : 'Total'}
              </div>
            )}
            <div className="sec-bottom-bar__price-value">R{totalPrice.toFixed(2)}</div>
          </div>
          <div className="sec-bottom-bar__cta">
            <button
              type="button"
              className="sec-btn sec-btn-primary sec-btn-full"
              disabled={isProcessing || !event?.has_entrance_fee}
              onClick={handlePay}
            >
              {isProcessing ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <>
                  <Ticket size={18} style={{ marginRight: 8 }} />
                  {totalPrice <= 0 ? 'Get free entrance' : 'Pay entrance'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
