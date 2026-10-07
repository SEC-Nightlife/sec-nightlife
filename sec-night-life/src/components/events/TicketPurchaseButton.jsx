import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/api/client';
import * as authService from '@/services/authService';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Ticket, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import RefundPolicyNote from '@/components/legal/RefundPolicyNote';
import { launchPaystackInline, loadPaystackScript } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import { getStoredPromoterRef } from '@/utils';
import { menuSelectionTotal, menuSelectionToPayload } from '@/components/menu/MenuPicker';
import VenueMenuBrowser from '@/components/menu/VenueMenuBrowser';
import MenuCheckoutLines from '@/components/checkout/MenuCheckoutLines';
import { maxTicketQuantity, ownedCountForTier, parseMaxPerUser } from '@/lib/ticketTierLimits';
import { ticketTierAllowsMenuAddons } from '@/lib/ticketMenuAddons';
import { SERVICE_FEE_LABEL, serviceFeeForSubtotal, totalWithServiceFee } from '@/lib/serviceFee';
import { useMoney } from '@/hooks/useMoney';
import ChargedInZarNote from '@/components/checkout/ChargedInZarNote';

const selectContentClass =
  'bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)] w-[var(--radix-select-trigger-width)]';

const selectItemClass =
  'text-[var(--sec-text-primary)] focus:bg-[var(--sec-bg-elevated)] focus:text-[var(--sec-text-primary)] data-[highlighted]:bg-[var(--sec-bg-elevated)]';

export default function TicketPurchaseButton({ event }) {
  const money = useMoney();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [holderNames, setHolderNames] = useState(['']);
  const [menuSelected, setMenuSelected] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);

  const venueId = event.venue_id;
  const availableTickets = event.ticket_tiers?.filter(t =>
    (t.quantity - (t.sold || 0)) > 0
  ) || [];
  const selectedTierData = event.ticket_tiers?.find(t => t.name === selectedTier);
  const menuEnabled = ticketTierAllowsMenuAddons(selectedTierData, event);

  const { data: venueMenu = [], isLoading: menuLoading } = useQuery({
    queryKey: ['venue-menu-public', venueId],
    queryFn: () => apiGet(`/api/business/venues/${venueId}/menu-items/public`),
    enabled: menuEnabled && !!venueId && isOpen,
  });

  useEffect(() => {
    loadPaystackScript().catch(() => {});
  }, []);

  useEffect(() => {
    setHolderNames((prev) => {
      const next = [...prev];
      while (next.length < quantity) next.push('');
      return next.slice(0, quantity);
    });
  }, [quantity]);

  useEffect(() => {
    if (!isOpen) setMenuSelected({});
  }, [isOpen]);

  useEffect(() => {
    setMenuSelected({});
  }, [selectedTier]);

  const ownedCount = ownedCountForTier(event, selectedTier);
  const maxPerUser = parseMaxPerUser(selectedTierData);
  const maxQuantity = selectedTierData
    ? maxTicketQuantity({ tier: selectedTierData, ownedCount })
    : 1;
  const atPerUserCap = Boolean(selectedTierData && maxPerUser != null && maxQuantity < 1);
  const ticketSubtotal = selectedTierData ? selectedTierData.price * quantity : 0;
  const menuSubtotal = menuEnabled ? menuSelectionTotal(venueMenu, menuSelected) : 0;
  const subtotalPrice = Math.round((ticketSubtotal + menuSubtotal) * 100) / 100;
  const serviceFee = serviceFeeForSubtotal(subtotalPrice);
  const totalPrice = totalWithServiceFee(subtotalPrice);

  useEffect(() => {
    if (maxQuantity >= 1 && quantity > maxQuantity) setQuantity(maxQuantity);
  }, [maxQuantity, quantity]);

  const handlePurchase = async () => {
    if (!selectedTier) {
      toast.error('Please select a ticket type');
      return;
    }
    if (atPerUserCap || maxQuantity < 1) {
      toast.error("You've reached the limit for this ticket.");
      return;
    }
    if (quantity > 1) {
      for (let i = 0; i < quantity; i++) {
        const parts = String(holderNames[i] || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          toast.error(`Enter first and surname for ticket ${i + 1}`);
          return;
        }
      }
    }

    if (window.self !== window.top) {
      toast.error('Checkout only works from the published app, not in preview mode');
      return;
    }

    setIsProcessing(true);
    try {
      const { user } = await authService.resolveUserForAction(window.location.href);
      const names =
        quantity > 1
          ? holderNames.map((n) => String(n).trim())
          : [holderDisplayNameFromUser(user)];
      const menuPayload = menuEnabled ? menuSelectionToPayload(venueMenu, menuSelected) : [];
      const promoterRef = getStoredPromoterRef(event.id);

      if (totalPrice <= 0) {
        const body = {
          ticket_tier_name: selectedTier,
          quantity,
          holder_names: names,
        };
        if (menuPayload.length > 0) body.selected_menu_items = menuPayload;
        if (promoterRef) body.promoter_user_id = promoterRef;
        const res = await apiPost(`/api/events/${event.id}/claim-free-ticket`, body);
        if (!res?.confirmed) throw new Error(res?.error || 'Could not claim free ticket');
        setIsOpen(false);
        setPaymentComplete(true);
        queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
        queryClient.invalidateQueries({ queryKey: ['event', event.id] });
        toast.success(
          quantity === 1
            ? 'Free ticket confirmed. View your QR in Profile → Tickets.'
            : `${quantity} free tickets confirmed. View your QR in Profile → Tickets.`,
        );
        return;
      }

      const metadata = {
        type: 'ticket',
        event_id: event.id,
        ticket_tier_name: selectedTier,
        quantity: String(quantity),
        holder_names: JSON.stringify(names),
      };
      if (menuPayload.length > 0) {
        metadata.selected_menu_items = menuPayload;
      }
      if (promoterRef) metadata.promoter_user_id = promoterRef;
      const res = await apiPost('/api/payments/initialize', {
        amount: totalPrice,
        email: user?.email,
        description: `${event.title} - ${selectedTier} x${quantity}`,
        event_id: event.id,
        metadata,
      });
      if (res?.reference && res?.access_code) {
        setIsOpen(false);
        await new Promise((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 120));
        });
        await launchPaystackInline({
          email: user?.email,
          amount: totalPrice,
          reference: res.reference,
          accessCode: res.access_code,
          authorizationUrl: res.authorization_url,
          onSuccess: (payload) => {
            setPaymentComplete(true);
            void completePaystackCheckout({ reference: res.reference, payload, queryClient });
          },
          onCancel: () => toast.message('Checkout cancelled'),
        });
      } else {
        throw new Error('No payment URL returned');
      }
    } catch (error) {
      if (error?.name === 'AuthRequiredError') return;
      if (error?.code === 'SESSION_SOFT_FAIL') {
        toast.error('Still signing you in — try again in a moment.');
        return;
      }
      console.error('Checkout error:', error);
      toast.error(error?.data?.error || error?.message || 'Failed to start checkout. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  function holderDisplayNameFromUser(u) {
    const n = u?.fullName || u?.username || u?.userProfile?.username;
    return n ? String(n).trim() : 'Guest';
  }

  function formatTierLabel(tier) {
    const left = tier.quantity - (tier.sold || 0);
    const category = tier.category ? ` (${tier.category})` : '';
    const priceLabel = Number(tier.price) <= 0 ? 'Free' : money.format(tier.price);
    const cap = parseMaxPerUser(tier);
    const capNote = cap != null ? ` · max ${cap}/person` : '';
    return `${tier.name}${category} — ${priceLabel} (${left} left${capNote})`;
  }

  const hasOnlyFreeTiers =
    availableTickets.length > 0 && availableTickets.every((t) => Number(t.price) <= 0);

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        disabled={paymentComplete}
        className="w-full sec-btn-accent"
      >
        <Ticket className="w-4 h-4 mr-2" />
        {paymentComplete ? 'Confirmed' : hasOnlyFreeTiers ? 'Get Free Tickets' : 'Buy Tickets'}
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="border text-[var(--sec-text-primary)] p-0 gap-0 overflow-hidden"
          style={{
            background: 'var(--sec-bg-card)',
            borderColor: 'var(--sec-border)',
            maxHeight: 'min(90vh, 720px)',
          }}
        >
          <DialogHeader className="px-5 pt-5 pb-3 border-b" style={{ borderColor: 'var(--sec-border)' }}>
            <DialogTitle style={{ color: 'var(--sec-text-primary)', fontSize: 18, fontWeight: 700 }}>
              {hasOnlyFreeTiers ? 'Get Free Tickets' : 'Purchase Tickets'}
            </DialogTitle>
          </DialogHeader>

          <div className="px-5 py-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 180px)' }}>
            <div className="mb-4">
              <Label className="text-sm mb-2 block" style={{ color: 'var(--sec-text-muted)' }}>Event</Label>
              <p className="font-semibold" style={{ color: 'var(--sec-text-primary)' }}>{event.title}</p>
            </div>

            {availableTickets.length === 0 ? (
              <div
                className="p-4 rounded-xl text-sm"
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  color: '#f87171',
                }}
              >
                No tickets available for this event
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <Label className="text-sm mb-3 block" style={{ color: 'var(--sec-text-muted)' }}>Ticket Type</Label>
                  <Select value={selectedTier} onValueChange={setSelectedTier}>
                    <SelectTrigger
                      className="w-full"
                      style={{
                        background: 'var(--sec-bg-elevated)',
                        borderColor: 'var(--sec-border)',
                        color: 'var(--sec-text-primary)',
                      }}
                    >
                      <SelectValue placeholder="Select ticket type" />
                    </SelectTrigger>
                    <SelectContent position="popper" className={selectContentClass}>
                      {availableTickets.map((tier) => (
                        <SelectItem key={tier.name} value={tier.name} className={selectItemClass}>
                          {formatTierLabel(tier)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedTier ? (
                  <>
                    <div className="mb-4">
                      <Label className="text-sm mb-3 block" style={{ color: 'var(--sec-text-muted)' }}>Quantity</Label>
                      {atPerUserCap ? (
                        <p className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>
                          You&apos;ve reached the limit for this ticket.
                        </p>
                      ) : (
                        <Select
                          value={String(Math.min(quantity, Math.max(maxQuantity, 1)))}
                          onValueChange={(val) => setQuantity(parseInt(val, 10))}
                        >
                          <SelectTrigger
                            className="w-full"
                            style={{
                              background: 'var(--sec-bg-elevated)',
                              borderColor: 'var(--sec-border)',
                              color: 'var(--sec-text-primary)',
                            }}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent position="popper" className={selectContentClass}>
                            {Array.from({ length: Math.max(maxQuantity, 0) }, (_, i) => i + 1).map((num) => (
                              <SelectItem key={num} value={num.toString()} className={selectItemClass}>
                                {num} {num === 1 ? 'ticket' : 'tickets'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {maxPerUser != null && !atPerUserCap ? (
                        <p className="text-xs mt-2" style={{ color: 'var(--sec-text-muted)' }}>
                          Limit {maxPerUser} per person
                          {ownedCount > 0 ? ` · you already have ${ownedCount}` : ''}
                        </p>
                      ) : null}
                    </div>

                    {quantity > 1 ? (
                      <div className="space-y-2 mb-4">
                        <Label className="text-sm" style={{ color: 'var(--sec-text-muted)' }}>Guest name per ticket</Label>
                        {Array.from({ length: quantity }, (_, i) => (
                          <Input
                            key={i}
                            placeholder={`Ticket ${i + 1}: First name & surname`}
                            value={holderNames[i] || ''}
                            onChange={(e) => {
                              const next = [...holderNames];
                              next[i] = e.target.value;
                              setHolderNames(next);
                            }}
                            style={{
                              background: 'var(--sec-bg-elevated)',
                              borderColor: 'var(--sec-border)',
                              color: 'var(--sec-text-primary)',
                            }}
                          />
                        ))}
                      </div>
                    ) : null}

                    {selectedTierData?.description ? (
                      <div
                        className="p-3 rounded-lg mb-4"
                        style={{ background: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)' }}
                      >
                        <p className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>{selectedTierData.description}</p>
                      </div>
                    ) : null}

                    {menuEnabled ? (
                      <div className="pt-3 mb-4 border-t" style={{ borderColor: 'var(--sec-border)' }}>
                        <Label className="text-sm mb-3 block" style={{ color: 'var(--sec-text-muted)' }}>Optional menu add-ons</Label>
                        {menuLoading ? (
                          <p className="text-xs flex items-center gap-2" style={{ color: 'var(--sec-text-muted)' }}>
                            <Loader2 className="w-3 h-3 animate-spin" /> Loading menu…
                          </p>
                        ) : venueMenu.length === 0 ? (
                          <p className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>No menu items available right now.</p>
                        ) : (
                          <VenueMenuBrowser
                            items={venueMenu}
                            selected={menuSelected}
                            onChange={(id, qty) => setMenuSelected((s) => ({ ...s, [id]: qty }))}
                            hideStickyFooter
                          />
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>

          {selectedTier && availableTickets.length > 0 ? (
            <div
              className="px-5 py-4 border-t"
              style={{
                borderColor: 'var(--sec-border)',
                background: 'rgba(0,0,0,0.35)',
              }}
            >
              {menuSubtotal > 0 || serviceFee > 0 ? (
                <>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span style={{ color: 'var(--sec-text-muted)' }}>Tickets</span>
                    <span style={{ color: 'var(--sec-text-primary)' }}>R{ticketSubtotal.toLocaleString()}</span>
                  </div>
                  <MenuCheckoutLines items={venueMenu} selected={menuSelected} />
                  {serviceFee > 0 ? (
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span style={{ color: 'var(--sec-text-muted)' }}>{SERVICE_FEE_LABEL}</span>
                      <span style={{ color: 'var(--sec-text-primary)' }}>R{serviceFee.toFixed(2)}</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className="flex items-center justify-between mb-3">
                <span style={{ color: 'var(--sec-text-muted)' }}>Total</span>
                <span className="text-xl font-bold" style={{ color: 'var(--sec-text-primary)' }}>
                  R{totalPrice.toLocaleString()}
                </span>
              </div>
              <ChargedInZarNote amountZar={totalPrice} style={{ margin: '-8px 0 12px', textAlign: 'right' }} />

              <Button
                onClick={handlePurchase}
                disabled={isProcessing || paymentComplete || atPerUserCap}
                className="w-full sec-btn-accent"
                style={{ height: 48 }}
              >
                {paymentComplete ? (
                  'Confirmed'
                ) : isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Processing…
                  </>
                ) : atPerUserCap ? (
                  'Limit reached'
                ) : totalPrice <= 0 ? (
                  <>
                    <Ticket className="w-4 h-4 mr-2" />
                    Get free ticket
                  </>
                ) : (
                  <>
                    <CreditCard className="w-4 h-4 mr-2" />
                    Continue to checkout
                  </>
                )}
              </Button>

              {totalPrice > 0 ? (
                <p className="text-xs text-center mt-2" style={{ color: 'var(--sec-text-muted)' }}>
                  Secure payment powered by Paystack
                </p>
              ) : (
                <p className="text-xs text-center mt-2" style={{ color: 'var(--sec-text-muted)' }}>
                  Free — you&apos;ll get a QR code in Profile → Tickets
                </p>
              )}
              {totalPrice > 0 ? (
                <RefundPolicyNote className="text-center mt-2" style={{ color: 'var(--sec-text-muted)' }} />
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
