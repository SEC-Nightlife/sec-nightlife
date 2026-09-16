import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

const GOLD = [201, 162, 39];
const DARK = [28, 28, 28];
const MUTED = [85, 85, 85];

function formatZar(n) {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  return `R${x.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cell(value) {
  const s = value == null ? '' : String(value).trim();
  return s || '—';
}

export function purchaseLogPdfFilename(data) {
  const fromExcel = String(data?.filename || '').replace(/\.xlsx$/i, '.pdf');
  if (fromExcel.endsWith('.pdf')) return fromExcel;
  return 'purchase-log.pdf';
}

function tableTheme() {
  return {
    theme: 'striped',
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 2.2,
      overflow: 'linebreak',
      valign: 'top',
      textColor: [17, 17, 17],
    },
    headStyles: {
      fillColor: DARK,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    footStyles: {
      fillColor: GOLD,
      textColor: [17, 17, 17],
      fontStyle: 'bold',
    },
    alternateRowStyles: { fillColor: [247, 245, 238] },
    margin: { left: 12, right: 12 },
  };
}

export function buildPurchaseLogPdf(data = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const title = data.eventTitle || 'Event';
  const groups = data.groups || [];
  const guestTotals = data.guestTotals || [];
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFillColor(...DARK);
  doc.rect(0, 0, pageWidth, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(`Purchase log — ${title}`, 12, 11);

  doc.setTextColor(...MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const subtitle = [data.eventDate, `${data.rowCount || 0} ${(data.rowCount || 0) === 1 ? 'purchase' : 'purchases'}`]
    .filter(Boolean)
    .join('  ·  ');
  doc.text(subtitle || 'SEC Nightlife', 12, 26);

  doc.setFillColor(...GOLD);
  doc.roundedRect(12, 31, pageWidth - 24, 10, 1.5, 1.5, 'F');
  doc.setTextColor(17, 17, 17);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Grand total paid ${formatZar(data.totalZar)}`, 16, 37.6);

  let cursorY = 46;

  if (guestTotals.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    doc.text('Amount paid by each guest', 12, cursorY);
    cursorY += 4;
    autoTable(doc, {
      ...tableTheme(),
      startY: cursorY,
      tableWidth: pageWidth - 24,
      head: [['Guest', 'Email', 'Purchases', 'Total paid']],
      body: guestTotals.map((guest) => [
        cell(guest.guestName),
        cell(guest.email),
        String(guest.count ?? 0),
        formatZar(guest.totalZar),
      ]),
      foot: [['Grand total', '', String(data.rowCount || guestTotals.reduce((n, g) => n + (g.count || 0), 0)), formatZar(data.totalZar)]],
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
    });
    cursorY = (doc.lastAutoTable?.finalY || cursorY) + 10;
  }

  if (!groups.length) {
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...MUTED);
    doc.text('No purchases recorded for this event.', 12, cursorY);
  } else {
    for (const group of groups) {
      if (cursorY > doc.internal.pageSize.getHeight() - 40) {
        doc.addPage();
        cursorY = 16;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...DARK);
      doc.text(
        `${group.title}   ·   ${group.count}   ·   ${formatZar(group.subtotal)}`,
        12,
        cursorY,
      );
      cursorY += 4;
      autoTable(doc, {
        ...tableTheme(),
        startY: cursorY,
        tableWidth: pageWidth - 24,
        head: [['Guest', 'Email', 'What they paid for', 'This purchase', 'Guest total', 'Paid at', 'Table', 'Status']],
        body: (group.rows || []).map((row) => [
          cell(row['Guest name']),
          cell(row.Email),
          cell(row['What they paid for']),
          formatZar(row['Amount (ZAR)']),
          formatZar(row['Guest total (ZAR)'] ?? row['Amount (ZAR)']),
          cell(row['Paid at']),
          cell(row.Table),
          cell(row.Status),
        ]),
        columnStyles: {
          3: { halign: 'right' },
          4: { halign: 'right' },
        },
      });
      cursorY = (doc.lastAutoTable?.finalY || cursorY) + 10;
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(
      `SEC Nightlife  ·  ${i} / ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 6,
      { align: 'center' },
    );
  }

  return doc;
}

export function downloadAndOpenPurchaseLogPdf(data) {
  const doc = buildPurchaseLogPdf(data);
  const filename = purchaseLogPdfFilename(data);
  const blob = new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const preview = window.open(url, '_blank');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();

  const revoke = () => URL.revokeObjectURL(url);
  if (preview && !preview.closed) {
    const poll = window.setInterval(() => {
      if (preview.closed) {
        window.clearInterval(poll);
        revoke();
      }
    }, 1500);
    window.setTimeout(() => {
      window.clearInterval(poll);
      revoke();
    }, 10 * 60 * 1000);
  } else {
    window.setTimeout(revoke, 20000);
  }
  return { filename, opened: Boolean(preview && !preview.closed) };
}
