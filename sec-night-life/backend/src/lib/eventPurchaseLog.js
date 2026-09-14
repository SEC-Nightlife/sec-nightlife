import { prisma } from './prisma.js';
import { flattenPaymentMetadata, basePaymentReference } from './paymentMetadata.js';
import { parseMenuItemLines } from './orderFulfillment.js';
import { isRefundedPaymentRef, loadRefundedPaymentRefs } from './refunds.js';
import { currentClockSast, formatYmdSast } from './dayBookingWindows.js';

const CSV_BOM = '\uFEFF';

export const PURCHASE_LOG_COLUMNS = [
  'Guest name',
  'Email',
  'Type',
  'What they paid for',
  'Amount (ZAR)',
  'Paid at',
  'Table',
  'Payment reference',
  'Status',
];

const EXCLUDED_PAYMENT_TYPES = new Set([
  'EVENT_BOOST',
  'TABLE_BOOST',
  'VENUE_TABLE_BOOST',
  'TABLE_HOST_FEE_EXTERNAL',
  'HOSTED_TABLE_EXTERNAL_LISTING',
  'HOUSE_PARTY_ENTRANCE',
  'HOUSE_PARTY_PUBLISH',
  'HOUSE_PARTY_BOOST',
  'promotion',
  'BOOST',
]);

const USER_BRIEF = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  userProfile: { select: { username: true } },
};

const VENUE_MEMBER_STATUSES = new Set(['CONFIRMED', 'LEFT', 'APPROVED', 'REFUNDED', 'PENDING_VENUE_REVIEW']);

export function canonicalPurchaseRef(ref) {
  return basePaymentReference(ref).replace(/-\d+$/, '');
}

export function moneyZar(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function formatZarLabel(n) {
  const x = moneyZar(n);
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

export function escapeCsvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(rows, columns = PURCHASE_LOG_COLUMNS) {
  // Excel (especially South Africa locale) ignores commas unless sep= is declared.
  const header = columns.map(escapeCsvCell).join(',');
  const body = (rows || []).map((row) => columns.map((col) => escapeCsvCell(row[col] ?? '')).join(','));
  return `${CSV_BOM}sep=,\r\n${[header, ...body].join('\r\n')}\r\n`;
}

export function formatPaidAtSast(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const ymd = formatYmdSast(d);
  const clock = currentClockSast(d);
  return clock ? `${ymd} ${clock}` : ymd;
}

export function slugifyFilenamePart(value, fallback = 'event') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export function purchaseLogFilename(event) {
  const title = slugifyFilenamePart(event?.title);
  let date = '';
  if (event?.date instanceof Date && !Number.isNaN(event.date.getTime())) {
    date = formatYmdSast(event.date);
  } else if (event?.date) {
    const raw = String(event.date);
    date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : formatYmdSast(new Date(event.date));
  }
  if (!date) date = formatYmdSast(new Date());
  return `purchase-log-${title}-${date}.xls`;
}

export function formatEventDateLabel(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime()) && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    const parts = date.slice(0, 10).split('-');
    const named = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T12:00:00+02:00`);
    if (!Number.isNaN(named.getTime())) {
      return named.toLocaleDateString('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
  }
  if (Number.isNaN(d.getTime())) return String(date).slice(0, 10);
  return d.toLocaleDateString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlStringCell(value, styleId, mergeAcross = 0) {
  const merge = mergeAcross > 0 ? ` ss:MergeAcross="${mergeAcross}"` : '';
  const style = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Cell${style}${merge}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function xmlNumberCell(value, styleId = 'Money') {
  const n = moneyZar(value);
  return `<Cell ss:StyleID="${styleId}"><Data ss:Type="Number">${n}</Data></Cell>`;
}

const EXCEL_COLUMNS = [
  { key: 'Guest name', width: 140 },
  { key: 'Email', width: 200 },
  { key: 'Type', width: 92 },
  { key: 'What they paid for', width: 280 },
  { key: 'Amount (ZAR)', width: 92, number: true },
  { key: 'Paid at', width: 110 },
  { key: 'Table', width: 180 },
  { key: 'Payment reference', width: 170 },
  { key: 'Status', width: 80 },
];

/**
 * Excel 2003 SpreadsheetML — opens with real columns, header bar, freeze, and filters.
 */
export function rowsToExcelXml({ eventTitle, eventDate, rows = [] } = {}) {
  const title = eventTitle || 'Event';
  const dateLabel = formatEventDateLabel(eventDate);
  const total = (rows || []).reduce((sum, row) => sum + moneyZar(row['Amount (ZAR)']), 0);
  const count = rows.length;
  const summary = [
    dateLabel,
    `${count} ${count === 1 ? 'purchase' : 'purchases'}`,
    `Total R${formatZarLabel(total)}`,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const colXml = EXCEL_COLUMNS.map((c) => `<Column ss:AutoFitWidth="0" ss:Width="${c.width}"/>`).join('');
  const headerXml = `<Row ss:Height="22">${EXCEL_COLUMNS.map((c) => xmlStringCell(c.key, 'Header')).join('')}</Row>`;

  const dataXml = (rows || []).map((row, idx) => {
    const zebra = idx % 2 === 1 ? 'Alt' : 'Data';
    const cells = EXCEL_COLUMNS.map((c) => {
      if (c.number) return xmlNumberCell(row[c.key], 'Money');
      const style =
        c.key === 'Status'
          ? row[c.key] === 'Paid'
            ? 'Paid'
            : row[c.key] === 'Refunded'
              ? 'Refunded'
              : 'Unpaid'
          : zebra;
      return xmlStringCell(row[c.key] ?? '', style);
    }).join('');
    return `<Row ss:Height="18">${cells}</Row>`;
  });

  if (!dataXml.length) {
    dataXml.push(
      `<Row ss:Height="18">${xmlStringCell('No purchases recorded for this event.', 'Muted', EXCEL_COLUMNS.length - 1)}</Row>`,
    );
  }

  const lastDataRow = 4 + Math.max(rows.length, 1);
  const totalRow = `<Row ss:Height="20">${xmlStringCell('Total', 'TotalLabel', 3)}${xmlNumberCell(total, 'TotalMoney')}${xmlStringCell('', 'Total')}${xmlStringCell('', 'Total')}${xmlStringCell('', 'Total')}${xmlStringCell('', 'Total')}</Row>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1A1A1A"/><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="Title"><Font ss:FontName="Calibri" ss:Size="16" ss:Bold="1" ss:Color="#111111"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Subtitle"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#555555"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Header"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1C1C1C" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C9A227"/></Borders></Style>
  <Style ss:ID="Data"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1A1A1A"/><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="Alt"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1A1A1A"/><Interior ss:Color="#F6F4EF" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="Money"><NumberFormat ss:Format="#,##0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>
  <Style ss:ID="Paid"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#1F7A3A"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Refunded"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#B42318"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Unpaid"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#7A5C00"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Muted"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#777777" ss:Italic="1"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Total"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/><Interior ss:Color="#EEE8D5" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="TotalLabel"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/><Interior ss:Color="#EEE8D5" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="TotalMoney"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/><NumberFormat ss:Format="&quot;R&quot;#,##0.00"/><Interior ss:Color="#EEE8D5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>
 </Styles>
 <Worksheet ss:Name="Purchase log">
  <Names>
   <NamedRange ss:Name="_FilterDatabase" ss:RefersTo="='Purchase log'!R4C1:R${lastDataRow}C${EXCEL_COLUMNS.length}" ss:Hidden="1"/>
  </Names>
  <Table ss:ExpandedColumnCount="${EXCEL_COLUMNS.length}" ss:ExpandedRowCount="${lastDataRow + 1}" x:FullColumns="1" x:FullRows="1">
   ${colXml}
   <Row ss:Height="28">${xmlStringCell(`Purchase log — ${title}`, 'Title', EXCEL_COLUMNS.length - 1)}</Row>
   <Row ss:Height="20">${xmlStringCell(summary || 'SEC Nightlife', 'Subtitle', EXCEL_COLUMNS.length - 1)}</Row>
   <Row ss:Height="10">${xmlStringCell('', 'Data', EXCEL_COLUMNS.length - 1)}</Row>
   ${headerXml}
   ${dataXml.join('\n   ')}
   ${totalRow}
  </Table>
  <AutoFilter x:Range="R4C1:R${lastDataRow}C${EXCEL_COLUMNS.length}" xmlns="urn:schemas-microsoft-com:office:excel"/>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>4</SplitHorizontal>
   <TopRowBottomPane>4</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
</Workbook>
`;
}

export function guestDisplayName(user) {
  if (!user) return '';
  return String(user.fullName || user.userProfile?.username || user.username || '').trim();
}

export function formatMenuSummary(lines) {
  const parts = [];
  for (const line of lines || []) {
    const name = String(line?.name || '').trim();
    if (!name) continue;
    const qty = Math.max(1, parseInt(String(line.quantity ?? 1), 10) || 1);
    const total = moneyZar(line.lineTotal);
    parts.push(total > 0 ? `${name} ×${qty} (R${formatZarLabel(total)})` : `${name} ×${qty}`);
  }
  return parts.join('; ');
}

export function classifyPurchaseType({ metaType, ticketKind, bookingRole, memberRole } = {}) {
  const t = String(metaType || '');
  if (t === 'HOSTED_TABLE_MENU') return 'Table menu';
  if (t === 'ticket' || t === 'event' || ticketKind === 'EVENT_TICKET') return 'Ticket';
  if (t === 'EVENT_ENTRANCE' || ticketKind === 'EVENT_ENTRANCE' || bookingRole === 'ENTRANCE') {
    return 'Entrance';
  }
  if (
    bookingRole === 'HOST' ||
    memberRole === 'HOST' ||
    t === 'TABLE_HOST_FEE' ||
    ticketKind === 'TABLE_HOST_FEE'
  ) {
    return 'Table host';
  }
  if (
    bookingRole === 'GUEST' ||
    memberRole === 'GUEST' ||
    t === 'HOSTED_TABLE_JOIN' ||
    ticketKind === 'HOSTED_TABLE_JOIN' ||
    ticketKind === 'VENUE_TABLE_JOIN' ||
    ticketKind === 'TABLE_JOIN'
  ) {
    return 'Table guest';
  }
  if (t === 'TABLE_CHECKOUT' || t === 'VENUE_TABLE_JOIN' || t === 'table') {
    return memberRole === 'HOST' ? 'Table host' : 'Table guest';
  }
  return '';
}

export function describePurchase({
  type,
  tierName,
  quantity,
  menuLines,
  entranceZar,
  joinFeeZar,
  hostFeeZar,
  minSpendZar,
  bookingFeeZar,
} = {}) {
  const parts = [];
  if (type === 'Ticket') {
    const qty = Math.max(1, parseInt(String(quantity ?? 1), 10) || 1);
    parts.push(`${tierName || 'Ticket'} ×${qty}`);
  } else if (type === 'Entrance') {
    const ent = moneyZar(entranceZar);
    parts.push(ent > 0 ? `Entrance fee (R${formatZarLabel(ent)})` : 'Entrance pass');
  } else if (type === 'Table host') {
    if (moneyZar(hostFeeZar) > 0) parts.push(`Host booking fee (R${formatZarLabel(hostFeeZar)})`);
    if (moneyZar(bookingFeeZar) > 0) parts.push(`Booking fee (R${formatZarLabel(bookingFeeZar)})`);
    if (moneyZar(entranceZar) > 0) parts.push(`Entrance fee (R${formatZarLabel(entranceZar)})`);
    if (moneyZar(minSpendZar) > 0) parts.push(`Minimum spend (R${formatZarLabel(minSpendZar)})`);
  } else if (type === 'Table guest') {
    if (moneyZar(joinFeeZar) > 0) parts.push(`Joining fee (R${formatZarLabel(joinFeeZar)})`);
    if (moneyZar(bookingFeeZar) > 0) parts.push(`Join booking fee (R${formatZarLabel(bookingFeeZar)})`);
    if (moneyZar(entranceZar) > 0) parts.push(`Entrance fee (R${formatZarLabel(entranceZar)})`);
  }

  const menu = formatMenuSummary(menuLines);
  if (menu) parts.push(menu);
  else if (type === 'Table menu') parts.push('Menu order');

  if (!parts.length) {
    if (type === 'Table host') return 'Hosted table';
    if (type === 'Table guest') return 'Joined table';
    if (type === 'Entrance') return 'Entrance pass';
    return type || '';
  }
  return parts.join(' · ');
}

function paymentEventId(meta) {
  const m = flattenPaymentMetadata(meta);
  const id = m.event_id ?? m.eventId;
  return id != null && String(id).trim() ? String(id) : null;
}

function preferText(a, b) {
  const left = a != null ? String(a).trim() : '';
  if (left) return left;
  return b != null ? String(b).trim() : '';
}

function mergeMenuLines(a, b) {
  const combined = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  if (!combined.length) return [];
  const byKey = new Map();
  for (const line of combined) {
    const key = line.menuItemId || `${line.name}:${line.quantity}:${line.lineTotal}`;
    if (!byKey.has(key)) byKey.set(key, line);
  }
  return [...byKey.values()];
}

function emptyRecord() {
  return {
    guestName: '',
    email: '',
    type: '',
    tierName: '',
    quantity: 0,
    menuLines: [],
    entranceZar: 0,
    joinFeeZar: 0,
    hostFeeZar: 0,
    minSpendZar: 0,
    bookingFeeZar: 0,
    amountZar: 0,
    paidAt: null,
    tableName: '',
    paymentReference: '',
    refunded: false,
    fromPayment: false,
  };
}

function upsertRecord(map, key, patch) {
  const k = String(key || '').trim();
  if (!k) return;
  const prev = map.get(k) || emptyRecord();
  const next = {
    ...prev,
    guestName: preferText(patch.guestName, prev.guestName),
    email: preferText(patch.email, prev.email),
    type: patch.fromPayment && patch.type ? patch.type : preferText(prev.type, patch.type),
    tierName: preferText(patch.tierName, prev.tierName),
    quantity: Math.max(Number(prev.quantity) || 0, Number(patch.quantity) || 0),
    menuLines: mergeMenuLines(prev.menuLines, patch.menuLines),
    entranceZar: moneyZar(patch.entranceZar) > 0 ? moneyZar(patch.entranceZar) : prev.entranceZar,
    joinFeeZar: moneyZar(patch.joinFeeZar) > 0 ? moneyZar(patch.joinFeeZar) : prev.joinFeeZar,
    hostFeeZar: moneyZar(patch.hostFeeZar) > 0 ? moneyZar(patch.hostFeeZar) : prev.hostFeeZar,
    minSpendZar: moneyZar(patch.minSpendZar) > 0 ? moneyZar(patch.minSpendZar) : prev.minSpendZar,
    bookingFeeZar: moneyZar(patch.bookingFeeZar) > 0 ? moneyZar(patch.bookingFeeZar) : prev.bookingFeeZar,
    tableName: preferText(patch.tableName, prev.tableName),
    paymentReference: preferText(patch.paymentReference, prev.paymentReference),
    refunded: Boolean(prev.refunded || patch.refunded),
    fromPayment: Boolean(prev.fromPayment || patch.fromPayment),
    paidAt: patch.paidAt && (!prev.paidAt || new Date(patch.paidAt) < new Date(prev.paidAt))
      ? patch.paidAt
      : prev.paidAt || patch.paidAt || null,
  };

  if (patch.fromPayment) {
    next.amountZar = moneyZar(patch.amountZar);
    if (patch.type) next.type = patch.type;
  } else if (!prev.fromPayment) {
    next.amountZar = moneyZar(Math.max(Number(prev.amountZar) || 0, Number(patch.amountZar) || 0));
  }

  map.set(k, next);
}

function recordStatus(row) {
  if (row.refunded) return 'Refunded';
  if (moneyZar(row.amountZar) > 0) return 'Paid';
  return 'Unpaid';
}

function toCsvRow(row) {
  const type = row.type || 'Ticket';
  const amount = row.refunded ? 0 : moneyZar(row.amountZar);
  return {
    'Guest name': row.guestName,
    Email: row.email,
    Type: type,
    'What they paid for': describePurchase({ ...row, type }),
    'Amount (ZAR)': formatZarLabel(amount),
    'Paid at': formatPaidAtSast(row.paidAt),
    Table: row.tableName,
    'Payment reference': row.paymentReference,
    Status: recordStatus({ ...row, amountZar: amount }),
  };
}

function collectRef(set, ref) {
  const canon = canonicalPurchaseRef(ref);
  if (canon) set.add(canon);
}

function metaFromPayment(pay) {
  return flattenPaymentMetadata(pay?.metadata);
}

function typeFromPaymentMeta(meta, memberRole) {
  return classifyPurchaseType({
    metaType: meta.type,
    memberRole,
    bookingRole: meta.member_role || meta.memberRole,
  });
}

/**
 * Assemble a per-event purchase log CSV for venue download.
 * @param {{ id: string, title?: string, date?: string, venueId: string }} event
 */
export async function buildEventPurchaseLog(event) {
  const eventId = event.id;
  const venueId = event.venueId;
  const refundedRefs = await loadRefundedPaymentRefs([venueId]);

  const [tickets, bookings, hostedTables, venueTables] = await Promise.all([
    prisma.ticket.findMany({
      where: {
        eventId,
        kind: { in: ['EVENT_TICKET', 'EVENT_ENTRANCE'] },
        hiddenFromHistoryAt: null,
      },
      include: { user: { select: USER_BRIEF } },
      take: 5000,
    }),
    prisma.eventVenueTableBooking.findMany({
      where: { eventId, venueId },
      include: {
        user: { select: USER_BRIEF },
        hostedTable: { select: { id: true, tableName: true } },
        venueTable: { select: { id: true, tableName: true } },
      },
      take: 5000,
    }),
    prisma.hostedTable.findMany({
      where: { eventId, tableType: 'IN_APP_EVENT' },
      include: {
        host: { select: USER_BRIEF },
        members: {
          where: { status: { in: ['GOING', 'CANCELLED'] } },
          include: { user: { select: USER_BRIEF } },
          take: 2000,
        },
      },
      take: 2000,
    }),
    prisma.venueTable.findMany({
      where: { eventId, venueId },
      include: {
        members: {
          include: { user: { select: USER_BRIEF } },
        },
      },
      take: 2000,
    }),
  ]);

  const refs = new Set();
  for (const t of tickets) collectRef(refs, t.paystackReference);
  for (const b of bookings) collectRef(refs, b.paystackReference);
  for (const ht of hostedTables) {
    collectRef(refs, ht.hostFeePaystackRef);
    for (const m of ht.members || []) collectRef(refs, m.paystackReference);
  }
  for (const vt of venueTables) {
    for (const m of vt.members || []) collectRef(refs, m.paystackReference);
  }

  const paymentOr = [
    { metadata: { path: ['event_id'], equals: eventId } },
    { metadata: { path: ['eventId'], equals: eventId } },
  ];
  const refList = [...refs];
  if (refList.length) paymentOr.push({ reference: { in: refList } });

  const payments = await prisma.payment.findMany({
    where: { status: 'success', OR: paymentOr },
    take: 5000,
  });

  const payerIds = [...new Set(payments.map((p) => p.userId).filter(Boolean))];
  const payers =
    payerIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: payerIds } },
          select: USER_BRIEF,
        })
      : [];
  const payerById = new Map(payers.map((u) => [u.id, u]));

  const byKey = new Map();

  for (const pay of payments) {
    const meta = metaFromPayment(pay);
    const eid = paymentEventId(pay.metadata);
    const canon = canonicalPurchaseRef(pay.reference);
    if (!canon) continue;
    if (eid && eid !== eventId && !refs.has(canon)) continue;
    if (!eid && !refs.has(canon)) continue;
    const metaType = String(meta.type || pay.type || '');
    if (EXCLUDED_PAYMENT_TYPES.has(metaType)) continue;

    const memberRole = meta.member_role || meta.memberRole || null;
    const type = typeFromPaymentMeta(meta, memberRole) || (isTicketPaymentish(meta, pay.type) ? 'Ticket' : '');
    const payer = payerById.get(pay.userId);
    const refunded = isRefundedPaymentRef(pay.reference, refundedRefs) || pay.refundStatus === 'APPROVED';

    upsertRecord(byKey, canon, {
      fromPayment: true,
      type,
      guestName: guestDisplayName(payer),
      email: preferText(pay.email, payer?.email),
      tierName: meta.ticket_tier_name || meta.ticketTierName || '',
      quantity: Math.max(1, parseInt(String(meta.quantity || '1'), 10) || 1),
      menuLines: parseMenuItemLines(meta.selected_menu_items ?? meta.selectedMenuItems),
      entranceZar: Number(meta.entrance_zar || 0) || 0,
      joinFeeZar: Number(meta.joining_fee_zar || meta.join_fee_zar || meta.join_zar || 0) || 0,
      hostFeeZar: Number(meta.host_table_fee_zar || meta.host_fee_zar || 0) || 0,
      minSpendZar: Number(meta.minimum_spend_zar || meta.min_spend_zar || 0) || 0,
      bookingFeeZar: Number(meta.booking_fee_zar || meta.custom_table_booking_fee_zar || 0) || 0,
      amountZar: Number(pay.amount) || 0,
      paidAt: pay.createdAt,
      paymentReference: canon,
      refunded,
    });
  }

  const ticketGroups = new Map();
  for (const t of tickets) {
    const canon = canonicalPurchaseRef(t.paystackReference) || `ticket:${t.id}`;
    if (!ticketGroups.has(canon)) {
      ticketGroups.set(canon, {
        kind: t.kind,
        user: t.user,
        subtitle: t.subtitle,
        holderDisplayName: t.holderDisplayName,
        createdAt: t.createdAt,
        refunded: Boolean(t.refundedAt),
        quantity: 0,
        paystackReference: canon.startsWith('ticket:') ? '' : canon,
      });
    }
    const g = ticketGroups.get(canon);
    g.quantity += Math.max(1, Number(t.quantity) || 1);
    if (t.refundedAt) g.refunded = true;
    if (t.subtitle) g.subtitle = t.subtitle;
  }

  for (const [canon, g] of ticketGroups) {
    upsertRecord(byKey, canon, {
      type: classifyPurchaseType({ ticketKind: g.kind }),
      guestName: g.holderDisplayName || guestDisplayName(g.user),
      email: g.user?.email || '',
      tierName: g.subtitle || '',
      quantity: g.quantity,
      paidAt: g.createdAt,
      paymentReference: g.paystackReference,
      refunded: g.refunded || isRefundedPaymentRef(g.paystackReference, refundedRefs),
    });
  }

  for (const b of bookings) {
    if (b.declineReason && !b.paystackReference) continue;
    const canon = canonicalPurchaseRef(b.paystackReference) || `booking:${b.id}`;
    const tableName = b.hostedTable?.tableName || b.venueTable?.tableName || '';
    const amount =
      moneyZar(b.amountTotal) > 0
        ? moneyZar(b.amountTotal)
        : moneyZar((Number(b.entranceZar) || 0) + (Number(b.componentZar) || 0));
    upsertRecord(byKey, canon, {
      type: classifyPurchaseType({ bookingRole: b.role }),
      guestName: guestDisplayName(b.user),
      email: b.user?.email || '',
      menuLines: parseMenuItemLines(b.selectedMenuItems),
      entranceZar: Number(b.entranceZar) || 0,
      amountZar: amount,
      paidAt: b.createdAt,
      tableName,
      paymentReference: canon.startsWith('booking:') ? '' : canon,
      refunded: isRefundedPaymentRef(b.paystackReference, refundedRefs),
      tierName: b.hostingTierName || '',
    });
  }

  for (const ht of hostedTables) {
    const hostRef = canonicalPurchaseRef(ht.hostFeePaystackRef);
    const hostName = guestDisplayName(ht.host);
    const hostEmail = ht.host?.email || '';
    const alreadyLoggedHost = [...byKey.values()].some(
      (row) =>
        row.type === 'Table host' &&
        row.tableName === (ht.tableName || '') &&
        ((hostEmail && row.email === hostEmail) || (hostName && row.guestName === hostName)),
    );
    if (hostRef || !alreadyLoggedHost) {
      const hostKey = hostRef || `hosted-host:${ht.id}`;
      upsertRecord(byKey, hostKey, {
        type: 'Table host',
        guestName: hostName,
        email: hostEmail,
        tableName: ht.tableName || '',
        paymentReference: hostRef,
        paidAt: ht.createdAt,
        minSpendZar: Number(ht.tierMinSpend) || 0,
      });
    }

    for (const m of ht.members || []) {
      if (m.status === 'CANCELLED' && !m.paystackReference) continue;
      const canon = canonicalPurchaseRef(m.paystackReference) || `htm:${m.id}`;
      const isHost = m.userId === ht.hostUserId;
      upsertRecord(byKey, canon, {
        type: isHost ? 'Table host' : 'Table guest',
        guestName: guestDisplayName(m.user),
        email: m.user?.email || '',
        menuLines: parseMenuItemLines(m.selectedMenuItems),
        joinFeeZar: Number(m.joinFeePaid) || 0,
        amountZar: moneyZar((Number(m.joinFeePaid) || 0) + (Number(m.menuSpendPaid) || 0)),
        paidAt: m.joinedAt,
        tableName: ht.tableName || '',
        paymentReference: canon.startsWith('htm:') ? '' : canon,
        refunded: isRefundedPaymentRef(m.paystackReference, refundedRefs),
      });
    }
  }

  for (const vt of venueTables) {
    for (const m of vt.members || []) {
      const paidish = (Number(m.amountPaid) || 0) > 0 || Boolean(m.paystackReference);
      if (!VENUE_MEMBER_STATUSES.has(m.status) && !paidish) continue;
      if (m.status === 'PENDING_PAYMENT' && !paidish) continue;
      if (m.status === 'DECLINED' && !paidish) continue;
      const canon = canonicalPurchaseRef(m.paystackReference) || `vtm:${m.id}`;
      upsertRecord(byKey, canon, {
        type: classifyPurchaseType({ memberRole: m.memberRole }),
        guestName: guestDisplayName(m.user),
        email: m.user?.email || '',
        menuLines: parseMenuItemLines(m.selectedMenuItems),
        minSpendZar: m.settlementMode === 'PREPAY_LUMP' ? Number(m.amountPaid) || 0 : 0,
        amountZar: Number(m.amountPaid) || 0,
        paidAt: m.paidAt || m.joinedAt,
        tableName: vt.tableName || '',
        paymentReference: canon.startsWith('vtm:') ? '' : canon,
        refunded: m.status === 'REFUNDED' || isRefundedPaymentRef(m.paystackReference, refundedRefs),
      });
    }
  }

  const rows = [...byKey.values()]
    .map((row) => {
      if (!row.type) row.type = row.tierName ? 'Ticket' : row.tableName ? 'Table guest' : 'Ticket';
      if (row.refunded) row.amountZar = 0;
      return toCsvRow(row);
    })
    .sort((a, b) => {
      const at = String(b['Paid at'] || '').localeCompare(String(a['Paid at'] || ''));
      if (at) return at;
      return String(a['Guest name'] || '').localeCompare(String(b['Guest name'] || ''));
    });

  return {
    filename: purchaseLogFilename(event),
    csv: rowsToCsv(rows),
    xls: rowsToExcelXml({ eventTitle: event.title, eventDate: event.date, rows }),
    rows,
  };
}

function isTicketPaymentish(meta, paymentType) {
  const t = String(meta?.type || paymentType || '');
  if (t === 'ticket' || t === 'event') return true;
  return Boolean((meta?.ticket_tier_name || meta?.ticketTierName) && (meta?.event_id || meta?.eventId));
}
