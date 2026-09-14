import React, { useState } from 'react';
import { Download, Loader2, Printer } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

function formatZar(n) {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  return `R${x.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function downloadBase64Xlsx(filename, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'purchase-log.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

function statusColor(status) {
  if (status === 'Paid') return '#3DDC84';
  if (status === 'Refunded') return '#F87171';
  return '#E8B84A';
}

function printPurchaseLog(data) {
  const groups = data.groups || [];
  const sections = groups
    .map((group) => {
      const rows = (group.rows || [])
        .map(
          (row) => `<tr>
            <td>${esc(row['Guest name'])}</td>
            <td>${esc(row.Email)}</td>
            <td>${esc(row['What they paid for'])}</td>
            <td class="num">${esc(formatZar(row['Amount (ZAR)']))}</td>
            <td>${esc(row['Paid at'])}</td>
            <td>${esc(row.Table)}</td>
            <td>${esc(row.Status)}</td>
          </tr>`,
        )
        .join('');
      return `<section>
        <h2>${esc(group.title)} <span>${group.count} · ${esc(formatZar(group.subtotal))}</span></h2>
        <table>
          <thead><tr>
            <th>Guest</th><th>Email</th><th>What they paid for</th><th>Amount</th><th>Paid at</th><th>Table</th><th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
    <title>${esc(data.eventTitle || 'Purchase log')}</title>
    <style>
      body { font-family: Calibri, Arial, sans-serif; color: #111; margin: 32px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .sub { color: #555; margin-bottom: 24px; }
      h2 { font-size: 15px; background: #111; color: #fff; padding: 8px 12px; margin: 24px 0 0; }
      h2 span { float: right; font-weight: 600; color: #C9A227; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
      th { text-align: left; background: #f3f1ea; padding: 8px; font-size: 12px; border-bottom: 2px solid #C9A227; }
      td { padding: 8px; border-bottom: 1px solid #eee; font-size: 12px; vertical-align: top; }
      .num { text-align: right; white-space: nowrap; }
      .total { background: #EEE8D5; font-weight: 700; padding: 12px; margin-top: 16px; }
      @media print { body { margin: 12px; } }
    </style></head><body>
      <h1>Purchase log — ${esc(data.eventTitle || 'Event')}</h1>
      <div class="sub">${esc(data.eventDate || '')} · ${data.rowCount || 0} purchases · ${esc(formatZar(data.totalZar))}</div>
      ${sections || '<p>No purchases recorded for this event.</p>'}
      <div class="total">Grand total ${esc(formatZar(data.totalZar))}</div>
    </body></html>`;

  const w = window.open('', '_blank', 'noopener,noreferrer,width=1024,height=768');
  if (!w) {
    toast.error('Allow pop-ups to print or save a PDF');
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default function EventPurchaseLogDialog({ open, onOpenChange, data }) {
  const [busy, setBusy] = useState(null);
  const groups = data?.groups || [];

  const downloadExcel = () => {
    if (!data?.xlsxBase64) {
      toast.error('Excel file is not ready yet');
      return;
    }
    setBusy('xlsx');
    try {
      downloadBase64Xlsx(data.filename, data.xlsxBase64);
      toast.success('Excel workbook downloaded');
    } catch {
      toast.error('Could not download Excel file');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="text-white sm:max-w-[920px] max-h-[88vh] overflow-hidden flex flex-col"
        style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
      >
        <DialogHeader className="px-1 pb-3 border-b border-[var(--sec-border)]">
          <DialogTitle>Purchase log</DialogTitle>
          <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginTop: 6 }}>
            {data?.eventTitle || 'Event'}
            {data?.eventDate ? ` · ${data.eventDate}` : ''}
            {` · ${data?.rowCount || 0} ${(data?.rowCount || 0) === 1 ? 'purchase' : 'purchases'}`}
            {` · ${formatZar(data?.totalZar)}`}
          </p>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 py-3 pr-1" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--sec-text-muted)', padding: 12 }}>
              No purchases recorded for this event.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.type}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: 10,
                    backgroundColor: 'var(--sec-bg-elevated, #1c1c22)',
                    border: '1px solid var(--sec-border)',
                    marginBottom: 8,
                  }}
                >
                  <strong style={{ fontSize: 14 }}>{group.title}</strong>
                  <span style={{ fontSize: 12, color: 'var(--sec-accent)' }}>
                    {group.count} · {formatZar(group.subtotal)}
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: 'var(--sec-text-muted)', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>Guest</th>
                        <th style={{ padding: '6px 8px' }}>Email</th>
                        <th style={{ padding: '6px 8px' }}>What they paid for</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                        <th style={{ padding: '6px 8px' }}>Table</th>
                        <th style={{ padding: '6px 8px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(group.rows || []).map((row, idx) => (
                        <tr key={`${group.type}-${idx}`} style={{ borderTop: '1px solid var(--sec-border)' }}>
                          <td style={{ padding: '8px', fontWeight: 600 }}>{row['Guest name'] || '—'}</td>
                          <td style={{ padding: '8px', color: 'var(--sec-text-muted)' }}>{row.Email || '—'}</td>
                          <td style={{ padding: '8px' }}>{row['What they paid for'] || '—'}</td>
                          <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {formatZar(row['Amount (ZAR)'])}
                          </td>
                          <td style={{ padding: '8px' }}>{row.Table || '—'}</td>
                          <td style={{ padding: '8px', color: statusColor(row.Status), fontWeight: 600 }}>
                            {row.Status || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-3 border-t border-[var(--sec-border)]">
          <Button
            type="button"
            onClick={downloadExcel}
            disabled={busy === 'xlsx'}
            style={{ backgroundColor: 'var(--sec-accent)', color: '#000', fontWeight: 600 }}
            className="h-10 rounded-xl"
          >
            {busy === 'xlsx' ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : <Download size={16} className="mr-1.5" />}
            Download Excel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => printPurchaseLog(data)}
            className="h-10 rounded-xl"
            style={{ borderColor: 'var(--sec-border)' }}
          >
            <Printer size={16} className="mr-1.5" />
            Print / Save PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
