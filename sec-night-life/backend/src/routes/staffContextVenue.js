import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { resolveStaffVenueContext, staffPermissionOk } from '../lib/access.js';
import { prisma } from '../lib/prisma.js';
import { ensureDayCustomVenueTable } from '../lib/ensureDayCustomVenueTable.js';
import { normalizeCountryCode, resolveTimeZone, zoneOf } from '../lib/timezone.js';
import { syncVenueLocaleToEvents } from '../lib/venueLocale.js';

const router = Router({ mergeParams: true });

const venueCreateSchema = z.object({
  name: z.string().min(1).max(200),
  venue_type: z.string().min(1),
  city: z.string().min(1),
  address: z.string().optional().nullable(),
  suburb: z.string().optional().nullable(),
  province: z.string().optional().nullable(),
  country_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  bio: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  website: z.string().url().optional().nullable().or(z.literal('')),
  instagram: z.string().optional().nullable(),
  capacity: z.number().int().min(0).optional().nullable(),
  age_limit: z.number().int().min(0).optional().nullable(),
  logo_url: z.string().url().optional().nullable().or(z.literal('')),
  cover_image_url: z.string().url().optional().nullable().or(z.literal('')),
});

async function requireStaffVenuePage(req, res, next) {
  try {
    const ctx = await resolveStaffVenueContext({
      token: req.params.accessToken,
      userId: req.userId,
    });
    if (!ctx) return res.status(404).json({ error: 'Staff context not found' });
    if (!staffPermissionOk(ctx.permissions, 'venue_page')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.staffVenueContext = ctx;
    next();
  } catch (e) {
    next(e);
  }
}

function mapVenueRow(venue) {
  return {
    id: venue.id,
    name: venue.name,
    venue_type: venue.venueType,
    city: venue.city,
    address: venue.address,
    suburb: venue.suburb,
    province: venue.province,
    country_code: venue.countryCode ?? null,
    timezone: zoneOf(venue),
    latitude: venue.latitude,
    longitude: venue.longitude,
    bio: venue.bio,
    is_verified: venue.isVerified,
    compliance_status: venue.complianceStatus,
    logo_url: venue.logoUrl,
    cover_image_url: venue.coverImageUrl,
    phone: venue.phone,
    email: venue.email,
    website: venue.website,
    instagram: venue.instagram,
    capacity: venue.capacity,
    age_limit: venue.ageLimit,
    accepts_day_bookings: venue.acceptsDayBookings,
    max_booking_duration_hours: venue.maxBookingDurationHours,
    host_table_fee_zar: venue.hostTableFeeZar,
    custom_table_booking_fee_zar: venue.customTableBookingFeeZar,
  };
}

router.get('/', authenticateToken, requireStaffVenuePage, async (req, res, next) => {
  try {
    const venue = await prisma.venue.findFirst({
      where: { id: req.staffVenueContext.venueId, deletedAt: null },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    res.json(mapVenueRow(venue));
  } catch (err) {
    next(err);
  }
});

router.patch('/', authenticateToken, requireStaffVenuePage, async (req, res, next) => {
  try {
    const venue = await prisma.venue.findFirst({
      where: { id: req.staffVenueContext.venueId, deletedAt: null },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const parsed = venueCreateSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const data = parsed.data;
    const extra = z
      .object({
        accepts_day_bookings: z.boolean().optional(),
        max_booking_duration_hours: z.number().int().min(1).nullable().optional(),
        host_table_fee_zar: z.number().min(0).optional(),
        custom_table_booking_fee_zar: z.number().min(0).optional(),
        external_booking_links: z.any().optional(),
        booking_policies: z.any().optional(),
      })
      .safeParse(req.body);
    const extraData = extra.success ? extra.data : {};

    const updates = {};
    if (data.name != null) updates.name = data.name;
    if (data.venue_type != null) updates.venueType = data.venue_type;
    if (data.city != null) updates.city = data.city;
    if (data.address != null) updates.address = data.address;
    if (data.suburb != null) updates.suburb = data.suburb;
    if (data.province != null) updates.province = data.province;
    if (data.latitude != null) updates.latitude = data.latitude;
    if (data.longitude != null) updates.longitude = data.longitude;
    if (data.country_code != null) {
      const cc = normalizeCountryCode(data.country_code);
      if (cc) updates.countryCode = cc;
    }
    if (data.latitude != null || data.longitude != null || updates.countryCode) {
      updates.timezone = resolveTimeZone({
        latitude: updates.latitude ?? venue.latitude,
        longitude: updates.longitude ?? venue.longitude,
        countryCode: updates.countryCode ?? venue.countryCode,
      });
    }
    if (data.bio != null) updates.bio = data.bio;
    if (data.phone != null) updates.phone = data.phone;
    if (data.email != null) updates.email = data.email;
    if (data.website !== undefined) updates.website = data.website;
    if (data.instagram != null) updates.instagram = data.instagram;
    if (data.capacity != null) updates.capacity = data.capacity;
    if (data.age_limit != null) updates.ageLimit = data.age_limit;
    if (data.logo_url !== undefined) updates.logoUrl = data.logo_url;
    if (data.cover_image_url !== undefined) updates.coverImageUrl = data.cover_image_url;
    if (extraData.accepts_day_bookings != null) updates.acceptsDayBookings = extraData.accepts_day_bookings;
    if (extra.success && 'max_booking_duration_hours' in extra.data) {
      updates.maxBookingDurationHours = extra.data.max_booking_duration_hours;
    }
    if (extra.success && 'host_table_fee_zar' in extra.data) {
      updates.hostTableFeeZar = extra.data.host_table_fee_zar;
    }
    if (extra.success && 'custom_table_booking_fee_zar' in extra.data) {
      updates.customTableBookingFeeZar = extra.data.custom_table_booking_fee_zar;
    }
    if (extraData.external_booking_links !== undefined) updates.externalBookingLinks = extraData.external_booking_links;
    if (extraData.booking_policies !== undefined) updates.bookingPolicies = extraData.booking_policies;

    const updated = await prisma.venue.update({
      where: { id: venue.id },
      data: updates,
    });
    if (updates.timezone || updates.countryCode) {
      await syncVenueLocaleToEvents(updated);
    }

    if (extraData.accepts_day_bookings === true) {
      await ensureDayCustomVenueTable(venue.id);
    }

    res.json(mapVenueRow(updated));
  } catch (err) {
    next(err);
  }
});

export default router;
