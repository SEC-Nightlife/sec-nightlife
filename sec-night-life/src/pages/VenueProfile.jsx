import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl, getVenueProfileShareUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { apiGet, apiPost } from '@/api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  Share2,
  MapPin,
  Phone,
  Globe,
  Instagram,
  Star,
  BadgeCheck,
  Calendar,
  Briefcase,
  Navigation,
  ChevronRight,
  Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import SecScrollTabs from '@/components/ui/SecScrollTabs';
import { toast } from 'sonner';
import { format, parseISO, isToday, isTomorrow, differenceInDays } from 'date-fns';
import { motion } from 'framer-motion';
import VenueReviewsSection from '@/components/reviews/VenueReviewsSection';
import VenueShareModal from '@/components/venues/VenueShareModal';
import { getDirectionsActions } from '@/lib/openDirections';
import ReportDialog from '@/components/moderation/ReportDialog';
import { useActiveVenueOptional } from '@/context/ActiveVenueContext';
import { instagramHandle, instagramProfileUrl, openExternalUrl, websiteHref } from '@/lib/externalLinks';
import { isEventEnded } from '@/lib/eventLifecycle';
import { useMoney } from '@/hooks/useMoney';
import { formatZar } from '@/lib/money';

function spotsLeft(job) {
  return Math.max((job.totalSpots || 0) - (job.filledSpots || 0), 0);
}

function jobTypeBadge(jobType) {
  return String(jobType || '').replace(/_/g, ' ');
}

function compensationLine(job, fmt = formatZar) {
  if (job.compensationLabel) return job.compensationLabel;
  if (job.compensationPer === 'COMMISSION') return 'Commission based';
  if (job.compensationType === 'NEGOTIABLE') return 'Negotiable';
  if (job.compensationType === 'UNPAID_TRIAL') return 'Unpaid trial';
  if (job.compensationAmount != null) {
    return `${fmt(job.compensationAmount)} per ${String(job.compensationPer || 'MONTH').toLowerCase()}`;
  }
  return 'Compensation not specified';
}

function eventDateLabel(date) {
  if (!date) return '';
  const d = parseISO(date);
  if (isToday(d)) return 'Tonight';
  if (isTomorrow(d)) return 'Tomorrow';
  return format(d, 'EEE, MMM d');
}

function VenueEventList({ events, showAttendance = false }) {
  const money = useMoney();
  return (
    <div className="space-y-4">
      {events.map((event, index) => (
        <motion.div
          key={event.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
        >
          <Link
            to={createPageUrl(`EventDetails?id=${event.id}`)}
            className="flex items-center gap-4 p-3 glass-card rounded-xl hover:bg-white/5 transition-colors"
          >
            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-[var(--sec-accent)]/20 to-[var(--sec-accent)]/20 flex-shrink-0 overflow-hidden">
              {event.cover_image_url ? (
                <img src={event.cover_image_url} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-[var(--sec-accent)]" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold">{event.title}</h4>
              <div className="flex items-center gap-3 mt-1 text-sm text-gray-400 flex-wrap">
                <span>{eventDateLabel(event.date)}</span>
                {event.start_time && <span>• {event.start_time}</span>}
                {event.has_entrance_fee && event.entrance_fee_amount != null && (
                  <span>• Entrance {money.format(event.entrance_fee_amount)}</span>
                )}
                {showAttendance ? (
                  <span>
                    • {Number(event.attendee_count || 0)} attended
                  </span>
                ) : null}
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-600" />
          </Link>
        </motion.div>
      ))}
    </div>
  );
}

function closingLabel(closingDate) {
  if (!closingDate) return 'No closing date';
  const days = differenceInDays(new Date(closingDate), new Date());
  if (days < 0) return 'Closed';
  if (days === 0) return 'Closes today';
  return `Closes in ${days} day${days === 1 ? '' : 's'}`;
}

function setOrRemoveMeta(attrName, value, isProperty = true) {
  const attr = isProperty ? 'property' : 'name';
  const selector = `meta[${attr}="${attrName}"]`;
  let el = document.head.querySelector(selector);
  if (!value) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, attrName);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

export default function VenueProfile() {
  const money = useMoney();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const venueIdFromUrl = searchParams.get('id');
  const activeVenueCtx = useActiveVenueOptional();
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const user = await authService.getCurrentUser();
        setCurrentUser(user);
      } catch {
        setCurrentUser(null);
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  const canFetchOwnedVenue = authReady && !!currentUser?.id && !venueIdFromUrl;
  const venueQueryEnabled = Boolean(venueIdFromUrl || canFetchOwnedVenue);

  const { data: venue, isLoading: venueLoading, isFetching: venueFetching } = useQuery({
    queryKey: ['venue', venueIdFromUrl, currentUser?.id, 'profile'],
    queryFn: async () => {
      if (venueIdFromUrl) {
        return apiGet(`/api/venues/${venueIdFromUrl}`);
      }
      if (currentUser?.id) {
        const activeId = activeVenueCtx?.activeVenueId;
        if (activeId) return apiGet(`/api/venues/${activeId}`);
        const venues = await dataService.Venue.mine();
        return venues[0];
      }
      return undefined;
    },
    enabled: venueQueryEnabled,
  });

  const resolvedVenueId = venue?.id ?? venueIdFromUrl ?? null;

  const { data: followStatus } = useQuery({
    queryKey: ['venue-follow-status', resolvedVenueId, currentUser?.id],
    queryFn: () => apiGet(`/api/venues/${resolvedVenueId}/follow-status`),
    enabled: !!resolvedVenueId && !!currentUser?.id,
  });
  const isFollowing = followStatus?.following ?? false;

  const followMutation = useMutation({
    mutationFn: () => apiPost(`/api/venues/${resolvedVenueId}/follow`, {}),
    onMutate: async () => {
      const key = ['venue-follow-status', resolvedVenueId, currentUser?.id];
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData(key);
      queryClient.setQueryData(key, { following: !isFollowing });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.key && ctx.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['venue-follow-status', resolvedVenueId] });
      queryClient.invalidateQueries({ queryKey: ['venue', venueIdFromUrl, currentUser?.id, 'profile'] });
      queryClient.invalidateQueries({ queryKey: ['user-profile', currentUser?.email] });
    },
  });

  const handleFollowClick = () => {
    if (!currentUser) {
      if (authService.hasRefreshSession()) {
        toast.error('Still signing you in — try again in a moment.');
        return;
      }
      authService.redirectToLogin(window.location.pathname + window.location.search, { force: true });
      return;
    }
    if (!resolvedVenueId) return;
    followMutation.mutate();
  };

  const { data: events = [] } = useQuery({
    queryKey: ['venue-events', resolvedVenueId],
    queryFn: async () => {
      const params = new URLSearchParams({
        venue_id: resolvedVenueId,
        status: 'published',
        include_ended: '1',
        sort: '-date',
        limit: '100',
      });
      const rows = await apiGet(`/api/events/filter?${params.toString()}`);
      return Array.isArray(rows) ? rows : rows?.items || [];
    },
    enabled: !!resolvedVenueId,
  });

  const { upcomingEvents, pastEvents } = useMemo(() => {
    const list = Array.isArray(events) ? events : [];
    const upcoming = [];
    const past = [];
    for (const event of list) {
      if (isEventEnded(event)) past.push(event);
      else upcoming.push(event);
    }
    return { upcomingEvents: upcoming, pastEvents: past };
  }, [events]);
  const eventCount = upcomingEvents.length + pastEvents.length;

  const { data: jobs = [] } = useQuery({
    queryKey: ['venue-jobs', resolvedVenueId],
    queryFn: () =>
      apiGet(`/api/jobs/public?${new URLSearchParams({ venueId: resolvedVenueId })}`),
    enabled: !!resolvedVenueId,
  });

  /* Many crawlers (WhatsApp, Telegram, Facebook) do not execute JavaScript; Open Graph tags set here may not appear in link previews for SPA-only pages. */
  useEffect(() => {
    if (!venue?.id) return;
    const canonical = getVenueProfileShareUrl(venue.id);
    const title = venue.name || 'Venue';
    const desc = (venue.bio || '').slice(0, 150);
    const image = venue.cover_image_url || venue.logo_url || '';
    document.title = `${title} | SEC Nightlife`;
    setOrRemoveMeta('og:title', title);
    setOrRemoveMeta('og:description', desc);
    setOrRemoveMeta('og:image', image);
    setOrRemoveMeta('og:url', canonical);
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'canonical');
      document.head.appendChild(link);
    }
    link.setAttribute('href', canonical);
    return () => {
      document.title = 'SEC Nightlife';
      ['og:title', 'og:description', 'og:image', 'og:url'].forEach((k) => setOrRemoveMeta(k, ''));
      if (link?.parentNode) link.remove();
    };
  }, [venue?.id, venue?.name, venue?.bio, venue?.cover_image_url, venue?.logo_url]);

  /* Deep linking requires the app to be registered on Play Store / App Store with the matching package name and URL scheme before this will work end-to-end. */
  useEffect(() => {
    if (!resolvedVenueId) return;
    const ua = navigator.userAgent || '';
    const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    if (!mobile) return;
    const t = setTimeout(() => {}, 2000);
    window.location.href = `secnightlife://venue?id=${encodeURIComponent(resolvedVenueId)}`;
    return () => clearTimeout(t);
  }, [resolvedVenueId]);

  const waitingForAuth = !venueIdFromUrl && !authReady;
  const showLoader = waitingForAuth || (venueQueryEnabled && (venueLoading || venueFetching));

  if (showLoader) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-12 h-12 rounded-full border-2 border-[var(--sec-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!venue) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Venue not found</h2>
          <Link to={createPageUrl('Explore')} style={{ color: 'var(--sec-accent)' }}>
            Browse Venues
          </Link>
        </div>
      </div>
    );
  }

  const getDateLabel = (date) => {
    if (!date) return '';
    const d = parseISO(date);
    if (isToday(d)) return 'Tonight';
    if (isTomorrow(d)) return 'Tomorrow';
    return format(d, 'EEE, MMM d');
  };

  const isOwner = currentUser?.id && venue.owner_user_id === currentUser.id;
  const showApply = currentUser && !isOwner;
  const venueWebsiteHref = websiteHref(venue.website);
  const venueInstagramHandle = instagramHandle(venue.instagram);
  const venueInstagramHref = instagramProfileUrl(venue.instagram);

  return (
    <div className="min-h-screen pb-8 max-w-app md:max-w-app-md mx-auto">
      <VenueShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        venueId={resolvedVenueId}
        venueName={venue.name}
      />

      <div className="relative w-full aspect-video">
        {venue.cover_image_url ? (
          <img src={venue.cover_image_url} alt={venue.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-[var(--sec-gradient-silver)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0B] via-transparent to-transparent" />

        <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-md flex items-center justify-center"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-md flex items-center justify-center"
              aria-label="Share venue"
            >
              <Share2 className="w-5 h-5" />
            </button>
          </div>
        </div>

        {venue.logo_url && (
          <div className="absolute bottom-4 left-4 w-20 h-20 rounded-2xl overflow-hidden border-4 border-[#0A0A0B]">
            <img src={venue.logo_url} alt="" className="w-full h-full object-cover" />
          </div>
        )}
      </div>

      <div className="px-4 lg:px-8 space-y-6">
        <div className="flex items-start justify-between pt-2">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{venue.name}</h1>
              {venue.is_verified && (
                <div className="w-6 h-6 rounded-full bg-[var(--sec-warning)] flex items-center justify-center">
                  <BadgeCheck className="w-4 h-4 text-black" />
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-400 flex-wrap">
              <span className="capitalize">{venue.venue_type?.replace('_', ' ')}</span>
              {typeof venue.follower_count === 'number' && (
                <>
                  <span>•</span>
                  <span>
                    {venue.follower_count} follower{venue.follower_count === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {venue.review_count > 0 && venue.review_average > 0 && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Star className="w-4 h-4 fill-[var(--sec-warning)] text-[var(--sec-warning)]" />
                    {Number(venue.review_average).toFixed(1)}
                  </span>
                </>
              )}
              {(!venue.review_count || venue.review_count === 0) && venue.rating > 0 && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Star className="w-4 h-4 fill-[var(--sec-warning)] text-[var(--sec-warning)]" />
                    {venue.rating.toFixed(1)}
                  </span>
                </>
              )}
              {venue.age_limit && (
                <>
                  <span>•</span>
                  <span>{venue.age_limit}+</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(venue.accepts_day_bookings || venue.acceptsDayBookings) && (
              <Link
                to={createPageUrl(`VenueBook?venueId=${resolvedVenueId}`)}
                className="sec-btn sec-btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 16px', textDecoration: 'none', fontSize: 14 }}
              >
                {isOwner ? 'Host a table here' : 'Book on Sec'}
              </Link>
            )}
            <Button
              onClick={handleFollowClick}
              disabled={followMutation.isPending}
              variant={isFollowing ? 'outline' : 'default'}
              className={isFollowing ? 'border-[#262629]' : 'bg-[var(--sec-accent)]'}
            >
              {followMutation.isPending ? '...' : isFollowing ? 'Following' : 'Follow'}
            </Button>
            {!isOwner && (
              <ReportDialog
                targetType="venue"
                targetId={resolvedVenueId}
                targetLabel={venue.name}
                triggerLabel="Report"
              />
            )}
          </div>
        </div>

        {venue.is_verified && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--sec-warning)]/10 border border-[var(--sec-warning)]/20">
            <Shield className="w-5 h-5 text-[var(--sec-warning)]" />
            <div>
              <p className="font-medium text-sm text-[var(--sec-warning)]">Verified Venue</p>
              <p className="text-xs text-gray-400">License and compliance verified</p>
            </div>
          </div>
        )}

        {venue.bio && <p className="text-gray-400">{venue.bio}</p>}

        <div className="glass-card rounded-2xl overflow-hidden">
          {venue.address && (() => {
            const dirs = getDirectionsActions({
              address: venue.address,
              lat: venue.latitude != null ? Number(venue.latitude) : null,
              lng: venue.longitude != null ? Number(venue.longitude) : null,
            });
            return (
              <>
                <a
                  href={dirs.primary.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-4 hover:bg-white/5 transition-colors"
                >
                  <MapPin className="w-5 h-5 text-[var(--sec-success)]" />
                  <span className="flex-1">{venue.address}</span>
                  <span className="text-xs text-gray-500 mr-1">{dirs.primary.label.replace('Open in ', '')}</span>
                  <Navigation className="w-4 h-4 text-gray-600" />
                </a>
                <a
                  href={dirs.secondary.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 pb-4 text-sm text-[var(--sec-accent)] hover:underline"
                >
                  {dirs.secondary.label}
                </a>
              </>
            );
          })()}
          {venue.phone && (
            <a
              href={`tel:${venue.phone}`}
              className="flex items-center gap-3 p-4 border-t border-[#262629] hover:bg-white/5 transition-colors"
            >
              <Phone className="w-5 h-5 text-[var(--sec-accent)]" />
              <span>{venue.phone}</span>
            </a>
          )}
          {venueWebsiteHref && (
            <a
              href={venueWebsiteHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => openExternalUrl(e, venueWebsiteHref)}
              className="flex items-center gap-3 p-4 border-t border-[#262629] hover:bg-white/5 transition-colors"
            >
              <Globe className="w-5 h-5 text-[var(--sec-accent)]" />
              <span>{venue.website}</span>
            </a>
          )}
          {venueInstagramHref && (
            <a
              href={venueInstagramHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => openExternalUrl(e, venueInstagramHref)}
              className="flex items-center gap-3 p-4 border-t border-[#262629] hover:bg-white/5 transition-colors"
            >
              <Instagram className="w-5 h-5 text-pink-500" />
              <span>{venueInstagramHandle ? `@${venueInstagramHandle}` : venue.instagram}</span>
            </a>
          )}
        </div>

        {(venue.music_genres?.length > 0 || venue.amenities?.length > 0) && (
          <div className="space-y-4">
            {venue.music_genres?.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Music</h3>
                <div className="flex flex-wrap gap-2">
                  {venue.music_genres.map((genre, index) => (
                    <span
                      key={index}
                      className="px-3 py-1 rounded-full bg-[var(--sec-accent)]/20 text-[var(--sec-accent)] text-sm"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {venue.amenities?.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Amenities</h3>
                <div className="flex flex-wrap gap-2">
                  {venue.amenities.map((amenity, index) => (
                    <span key={index} className="px-3 py-1 rounded-full bg-[#141416] text-gray-400 text-sm">
                      {amenity}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <Tabs defaultValue="events" className="w-full">
          <SecScrollTabs
            listClassName="bg-[#141416] p-1 rounded-xl"
            triggerClassName="rounded-lg data-[state=active]:bg-[#262629]"
            tabs={[
              { value: 'events', label: `Events (${eventCount})` },
              { value: 'jobs', label: `Jobs (${jobs.length})` },
            ]}
          />

          <TabsContent value="events" className="mt-4">
            <Tabs defaultValue="upcoming" className="w-full">
              <SecScrollTabs
                listClassName="bg-[#0A0A0B] p-1 rounded-lg border border-[#262629]"
                triggerClassName="rounded-md text-xs data-[state=active]:bg-[#262629]"
                tabs={[
                  { value: 'upcoming', label: `Upcoming (${upcomingEvents.length})` },
                  { value: 'past', label: `Past (${pastEvents.length})` },
                ]}
              />
              <TabsContent value="upcoming" className="mt-4">
                {upcomingEvents.length > 0 ? (
                  <VenueEventList events={upcomingEvents} />
                ) : (
                  <div className="text-center py-12">
                    <Calendar className="w-10 h-10 text-gray-600 mx-auto mb-2" />
                    <p className="text-gray-500">No upcoming events</p>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="past" className="mt-4">
                {pastEvents.length > 0 ? (
                  <VenueEventList events={pastEvents} showAttendance />
                ) : (
                  <div className="text-center py-12">
                    <Calendar className="w-10 h-10 text-gray-600 mx-auto mb-2" />
                    <p className="text-gray-500">No past events</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="jobs" className="mt-4">
            {jobs.length > 0 ? (
              <div className="space-y-3">
                {jobs.map((job, index) => (
                  <motion.div
                    key={job.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="glass-card rounded-xl p-3 space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-xl bg-[var(--sec-warning)]/20 flex items-center justify-center shrink-0">
                        <Briefcase className="w-5 h-5 text-[var(--sec-warning)]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold">{job.title}</h4>
                        <span className="inline-block mt-1 px-2 py-0.5 rounded-md text-xs bg-[#262629] text-gray-300 capitalize">
                          {jobTypeBadge(job.jobType)}
                        </span>
                        <p className="text-sm text-[var(--sec-success)] mt-2">{compensationLine(job, money.format)}</p>
                        <p className="text-sm text-gray-400 mt-1">
                          {spotsLeft(job)} spot{spotsLeft(job) === 1 ? '' : 's'} left
                        </p>
                        <p className="text-xs text-gray-500 mt-1">{closingLabel(job.closingDate)}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" size="sm" asChild>
                        <Link to={createPageUrl(`JobDetails?id=${job.id}`)}>View</Link>
                      </Button>
                      {showApply && (
                        <Button size="sm" className="bg-[var(--sec-accent)]" asChild>
                          <Link to={createPageUrl(`JobDetails?id=${job.id}`)}>Apply</Link>
                        </Button>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <Briefcase className="w-10 h-10 text-gray-600 mx-auto mb-2" />
                <p className="text-gray-500">No open positions at this venue</p>
              </div>
            )}
          </TabsContent>
        </Tabs>

        <VenueReviewsSection
          venueId={resolvedVenueId}
          venueName={venue.name}
          ownerUserId={venue.owner_user_id}
          currentUserId={currentUser?.id}
          isAuthenticated={!!currentUser}
        />
      </div>
    </div>
  );
}
