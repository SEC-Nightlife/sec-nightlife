import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

/** Venue → vendor hire request. Requires the viewer to own at least one venue. */
export default function HireRequestDialog({ open, onOpenChange, vendor, venues = [] }) {
  const queryClient = useQueryClient();
  const [venueId, setVenueId] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setVenueId(venues[0]?.id || '');
      setEventDate('');
      setMessage('');
    }
  }, [open, venues]);

  const minDate = new Date().toISOString().slice(0, 10);
  const valid = venueId && message.trim().length >= 10;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await apiPost(`/api/vendors/${encodeURIComponent(vendor.id)}/inquiries`, {
        venue_id: venueId,
        event_date: eventDate ? new Date(`${eventDate}T12:00:00`).toISOString() : null,
        message: message.trim(),
      });
      toast.success('Hire request sent. The vendor will be notified.');
      queryClient.invalidateQueries({ queryKey: ['vendor-hire-status', vendor.id] });
      queryClient.invalidateQueries({ queryKey: ['vendor-inquiries-sent'] });
      onOpenChange(false);
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not send request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-app md:max-w-app-md max-h-[90vh] overflow-y-auto bg-[#0A0A0B] border-[#262629]">
        <DialogHeader>
          <DialogTitle>Request to hire {vendor?.name}</DialogTitle>
          <DialogDescription className="text-gray-400">
            The vendor gets your request in the app and can accept or decline. Once you send it you can message
            each other directly — no friend request needed.
          </DialogDescription>
        </DialogHeader>

        <label className="block text-sm mb-1">Venue</label>
        <select
          className="w-full min-h-[44px] rounded-lg bg-[#141416] border border-[#262629] px-3 mb-4"
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>

        <label className="block text-sm mb-1">Event date (optional)</label>
        <Input
          type="date"
          min={minDate}
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
          className="min-h-[44px] bg-[#141416] border-[#262629] mb-4"
        />

        <label className="block text-sm mb-1">Message</label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={1000}
          rows={5}
          placeholder="What do you need, for how many guests, budget, set-up times…"
          className="min-h-[120px] bg-[#141416] border-[#262629]"
        />
        <p className="text-xs text-gray-500 mt-1">{message.length}/1000 · at least 10 characters</p>

        <Button type="button" className="w-full mt-4 min-h-[44px]" disabled={!valid || submitting} onClick={submit}>
          {submitting ? 'Sending…' : 'Send hire request'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
