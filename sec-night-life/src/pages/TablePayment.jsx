import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { apiPost } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { 
  ChevronLeft,
  CreditCard,
  Check,
  Calendar,
  Clock,
  MapPin,
  DollarSign,
  ShieldCheck
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { format, parseISO, isToday, isTomorrow } from 'date-fns';
import RefundPolicyNote from '@/components/legal/RefundPolicyNote';
import { useQueryClient } from '@tanstack/react-query';
import { launchPaystackInline } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import ChargedInZarNote from '@/components/checkout/ChargedInZarNote';

export default function TablePayment() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  
  const urlParams = new URLSearchParams(window.location.search);
  const tableId = urlParams.get('id');

  useEffect(() => {
    loadUser();
  }, []);

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
    queryFn: async () => {
      const tables = await dataService.Table.filter({ id: tableId });
      return tables[0];
    },
    enabled: !!tableId,
  });

  const { data: event } = useQuery({
    queryKey: ['table-event', table?.event_id],
    queryFn: async () => {
      const events = await dataService.Event.filter({ id: table.event_id });
      return events[0];
    },
    enabled: !!table?.event_id,
  });

  const { data: venue } = useQuery({
    queryKey: ['table-venue', table?.venue_id],
    queryFn: async () => {
      const venues = await dataService.Venue.filter({ id: table.venue_id });
      return venues[0];
    },
    enabled: !!table?.venue_id,
  });

  const member = table?.members?.find(m => m.user_id === userProfile?.id);
  const totalAmount = (member?.contribution || 0) + (table?.joining_fee || 0);

  const handlePayment = async () => {
    if (window.self !== window.top) {
      alert('Payment checkout only works in the published app. Please open the app in a new tab.');
      return;
    }
    setIsProcessing(true);
    try {
      const res = await apiPost('/api/payments/initialize', {
        amount: totalAmount,
        email: user?.email,
        description: `Table: ${table.name}${member?.contribution ? ` - Contribution R${member.contribution}` : ''}${table.joining_fee ? ` + Fee R${table.joining_fee}` : ''}`,
        metadata: { type: 'table', table_id: tableId, user_id: user?.id },
      });
      if (res?.reference && res?.access_code) {
        await launchPaystackInline({
          email: user?.email,
          amount: totalAmount,
          reference: res.reference,
          accessCode: res.access_code,
          authorizationUrl: res.authorization_url,
          onSuccess: async (payload) => {
            const result = await completePaystackCheckout({ reference: res.reference, payload, queryClient, showToasts: false });
            if (result?.fulfilled) {
              setPaymentComplete(true);
              return;
            }
            navigate(`${createPageUrl('PaymentSuccess')}?ref=${encodeURIComponent(res.reference)}`);
          },
          onCancel: () => {},
        });
      } else {
        throw new Error('No payment URL returned');
      }
    } catch (error) {
      console.error('Payment failed:', error);
      alert(error?.data?.error || error?.message || 'Payment failed. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const getDateLabel = () => {
    if (!event?.date) return '';
    const date = parseISO(event.date);
    if (isToday(date)) return 'Tonight';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'EEE, MMM d');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-12 h-12 rounded-full border-2 border-[var(--sec-success)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!table || !member) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Payment not available</h2>
          <Button
            onClick={() => navigate(createPageUrl('Tables'))}
            className="mt-4 bg-gradient-to-r from-[var(--sec-accent)] to-[var(--sec-accent)]"
          >
            Browse Tables
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-32">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#0A0A0B]/80 backdrop-blur-xl border-b border-[#262629]">
        <div className="px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-full bg-[#141416] flex items-center justify-center"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold">Complete Payment</h1>
          <div className="w-10" />
        </div>
      </header>

      <div className="px-4 lg:px-8 py-6 max-w-2xl mx-auto space-y-6">
        {/* Success Message */}
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[var(--sec-success)] to-[var(--sec-success)]/60 mx-auto mb-4 flex items-center justify-center">
            <Check className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Request Accepted! 🎉</h2>
          <p className="text-gray-400">
            Complete your payment to finalize joining the table
          </p>
        </div>

        {/* Table Info */}
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">Table</p>
            <p className="text-xl font-bold">{table.name}</p>
          </div>

          {event && (
            <div className="pt-4 border-t border-[#262629] space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-4 h-4 text-[var(--sec-accent)]" />
                <span>{getDateLabel()}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-[var(--sec-accent)]" />
                <span>{event.start_time || 'TBA'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <MapPin className="w-4 h-4 text-[var(--sec-success)]" />
                <span>{venue?.name || event.address}</span>
              </div>
            </div>
          )}
        </div>

        {/* Payment Breakdown */}
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-[var(--sec-success)]" />
            Payment Breakdown
          </h3>

          <div className="space-y-3">
            {member.contribution > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Your Contribution</span>
                <span className="font-semibold">R{member.contribution.toLocaleString()}</span>
              </div>
            )}

            {table.joining_fee > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Joining Fee</span>
                <span className="font-semibold">R{table.joining_fee.toLocaleString()}</span>
              </div>
            )}

            <div className="pt-3 border-t border-[#262629] flex items-center justify-between">
              <span className="text-lg font-semibold">Total Amount</span>
              <span className="text-2xl font-bold text-[var(--sec-success)]">R{totalAmount.toLocaleString()}</span>
            </div>
            <ChargedInZarNote amountZar={totalAmount} style={{ textAlign: 'right' }} />
          </div>
        </div>

        {/* Security Info */}
        <div className="p-4 rounded-xl bg-[var(--sec-accent)]/10 border border-[var(--sec-accent)]/20">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-[var(--sec-accent)] flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-sm mb-1">Secure Payment</p>
              <p className="text-xs text-gray-400">
                Powered by Paystack. Your payment information is encrypted and secure.
              </p>
            </div>
          </div>
        </div>

        <RefundPolicyNote className="text-center" />
      </div>

      {/* Fixed Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#0A0A0B]/95 backdrop-blur-xl border-t border-[#262629]">
        <div className="max-w-2xl mx-auto">
          <Button
            onClick={handlePayment}
            disabled={isProcessing || paymentComplete}
            className="w-full h-14 rounded-xl bg-gradient-to-r from-[var(--sec-success)] to-[var(--sec-success)]/80 font-semibold text-lg"
          >
            {paymentComplete ? (
              <>
                <Check className="w-5 h-5 mr-2" />
                Paid
              </>
            ) : isProcessing ? (
              'Processing...'
            ) : (
              <>
                <CreditCard className="w-5 h-5 mr-2" />
                Pay R{totalAmount.toLocaleString()}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}