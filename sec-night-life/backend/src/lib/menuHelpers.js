import { prisma } from './prisma.js';
import { formatVenueMenuItemForGuestMenu, resolveMenuSpecialState } from './menuSpecials.js';

/** Price a guest pays right now (special price inside an active special window). */
export function chargeableMenuUnitPrice(row) {
  return Number(resolveMenuSpecialState(row).displayPrice);
}

/** Live venue menu for guest browse/checkout (full catalog, not table-scoped subsets). */
export async function fetchGuestVenueMenuItems(venueId) {
  const rows = await prisma.venueMenuItem.findMany({
    where: { venueId, isAvailable: true },
    include: { catalogItem: { select: { imageUrl: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows
    .map((row) => formatVenueMenuItemForGuestMenu(row, row.catalogItem))
    .filter((item) => item.guest_visible);
}

/** Shape guest menu rows for venue table API responses. */
export function guestMenuItemToTableShape(item, venueTableId) {
  return {
    id: item.id,
    venueTableId,
    venueMenuItemId: item.id,
    menuItemId: item.id,
    name: item.name,
    category: item.category,
    sub_category: item.sub_category,
    subCategory: item.sub_category,
    price: item.price,
    original_price: item.original_price,
    imageUrl: item.image_url,
    image_url: item.image_url,
    isAvailable: true,
  };
}

/**
 * @param {Array<{ menuItemId: string, quantity: number }>} selections
 * @param {string} venueId
 * @param {{ guestVisibleOnly?: boolean }} [opts] reject items hidden from the guest menu
 */
export async function resolveVenueMenuSelections(selections, venueId, opts = {}) {
  if (!Array.isArray(selections) || selections.length === 0) {
    return { items: [], totalZar: 0 };
  }
  const ids = selections.map((s) => s.menuItemId).filter(Boolean);
  const menuRows = await prisma.venueMenuItem.findMany({
    where: { id: { in: ids }, venueId, isAvailable: true },
    include: opts.guestVisibleOnly ? { catalogItem: { select: { imageUrl: true } } } : undefined,
  });
  const map = new Map(
    menuRows
      .filter((m) => !opts.guestVisibleOnly || formatVenueMenuItemForGuestMenu(m, m.catalogItem).guest_visible)
      .map((m) => [m.id, m]),
  );
  const items = [];
  let totalZar = 0;
  for (const sel of selections) {
    const row = map.get(sel.menuItemId);
    if (!row) {
      const err = new Error(`Menu item not found: ${sel.menuItemId}`);
      err.status = 400;
      throw err;
    }
    const qty = Math.max(1, Math.floor(Number(sel.quantity) || 0));
    const unitPrice = chargeableMenuUnitPrice(row);
    const line = Math.round(qty * unitPrice * 100) / 100;
    totalZar += line;
    items.push({
      menuItemId: row.id,
      quantity: qty,
      unitPrice,
      name: row.name,
      image_url: row.imageUrl,
      category: row.category,
      lineTotalZar: line,
    });
  }
  return { items, totalZar: Number(totalZar.toFixed(2)) };
}

/**
 * Resolve tier included_items from hosting_config using venue menu.
 * @param {object} hostingConfig
 * @param {'GENERAL'|'VIP'} category
 * @param {number} tierIndex
 * @param {string} venueId
 */
export async function resolveTierIncludedItems(hostingConfig, category, tierIndex, venueId) {
  const catKey = category === 'VIP' ? 'vip' : 'general';
  const tiers = hostingConfig?.[catKey]?.tiers;
  if (!Array.isArray(tiers) || tierIndex == null) return [];
  const tier = tiers[tierIndex];
  const raw = tier?.included_items;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const ids = raw.map((x) => x.menu_item_id || x.menuItemId).filter(Boolean);
  const menuRows = ids.length
    ? await prisma.venueMenuItem.findMany({ where: { id: { in: ids }, venueId } })
    : [];
  const map = new Map(menuRows.map((m) => [m.id, m]));
  return raw.map((inc) => {
    const id = inc.menu_item_id || inc.menuItemId;
    const row = id ? map.get(id) : null;
    const qty = Math.max(1, Math.floor(Number(inc.quantity) || 1));
    return {
      menuItemId: id || null,
      quantity: qty,
      name: row?.name || inc.name || 'Included item',
      price: row ? Number(row.price) : Number(inc.price || 0),
      image_url: row?.imageUrl || inc.image_url || null,
    };
  });
}

export function includedItemsTotalZar(includedItems) {
  return (includedItems || []).reduce(
    (s, i) => s + Number(i.price || 0) * Number(i.quantity || 0),
    0
  );
}

export function mergeMemberMenuItems(existing, added) {
  const map = new Map();
  for (const line of existing || []) {
    const key = line.menuItemId;
    if (!key) continue;
    map.set(key, { ...line });
  }
  for (const line of added || []) {
    const key = line.menuItemId;
    if (!key) continue;
    const prev = map.get(key);
    if (prev) {
      const qty = Number(prev.quantity) + Number(line.quantity);
      map.set(key, {
        ...prev,
        quantity: qty,
        lineTotalZar: Number((qty * Number(prev.unitPrice || line.unitPrice)).toFixed(2)),
      });
    } else {
      map.set(key, { ...line });
    }
  }
  return Array.from(map.values());
}

export function formatMenuSummaryForTicket(table, members) {
  const parts = [];
  if (table?.hostingCategory) {
    const tierLabel = table.hostingTierIndex != null ? ` tier ${table.hostingTierIndex + 1}` : '';
    parts.push(`${table.hostingCategory}${tierLabel}`);
  }
  if (table?.tierMinSpend != null) {
    parts.push(`min spend R${Number(table.tierMinSpend)}`);
  }
  if (table?.menuSpendTotal > 0) {
    parts.push(`menu R${Number(table.menuSpendTotal)}`);
  }
  const hostMem = (members || []).find((m) => m.userId === table?.hostUserId);
  if (hostMem?.selectedMenuItems?.length) {
    parts.push(`${hostMem.selectedMenuItems.length} host items`);
  }
  return parts.length ? parts.join(' · ') : null;
}
