import React, { useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { downloadAndOpenPurchaseLogPdf } from '@/lib/eventPurchaseLogPdf';

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


export default function EventPurchaseLogDialog({ open, onOpenChange, data }) {
  const [busy, setBusy] = useState(null);
  const groups = data?.groups || [];
  const guestTotals = data?.guestTotals || [];

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

  const downloadPdf = () => {
    if (!data) {
      toast.error('Purchase log is not ready yet');
      return;
    }
    setBusy('pdf');
    try {
      const result = downloadAndOpenPurchaseLogPdf(data);
      toast.success(result.opened ? 'PDF opened and downloaded' : 'PDF downloaded');
    } catch {
      toast.error('Could not download PDF');
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
          </p>
          <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--sec-accent)', marginTop: 8 }}>
            Grand total paid {formatZar(data?.totalZar)}
          </p>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 py-3 pr-1" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {guestTotals.length ? (
            <section>
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
                <strong style={{ fontSize: 14 }}>Amount paid by each guest</strong>
                <span style={{ fontSize: 12, color: 'var(--sec-accent)' }}>{formatZar(data?.totalZar)}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--sec-text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>Guest</th>
                      <th style={{ padding: '6px 8px' }}>Email</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Purchases</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guestTotals.map((guest) => (
                      <tr key={guest.key} style={{ borderTop: '1px solid var(--sec-border)' }}>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{guest.guestName || '—'}</td>
                        <td style={{ padding: '8px', color: 'var(--sec-text-muted)' }}>{guest.email || '—'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{guest.count}</td>
                        <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>
                          {formatZar(guest.totalZar)}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--sec-accent)' }}>
                      <td style={{ padding: '8px', fontWeight: 700 }} colSpan={3}>Grand total</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, color: 'var(--sec-accent)' }}>
                        {formatZar(data?.totalZar)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
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
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>This purchase</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>Guest total</th>
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
                          <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>
                            {formatZar(row['Guest total (ZAR)'] ?? row['Amount (ZAR)'])}
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
            onClick={downloadPdf}
            disabled={busy === 'pdf'}
            className="h-10 rounded-xl"
            style={{ borderColor: 'var(--sec-border)' }}
          >
            {busy === 'pdf' ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : <FileText size={16} className="mr-1.5" />}
            Download PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
