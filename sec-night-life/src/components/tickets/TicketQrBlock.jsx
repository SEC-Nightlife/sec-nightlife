import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function TicketQrBlock({ verifyUrl, eventCode, compact = false }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [size, setSize] = useState(144);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(min-width: 640px)');
    const sync = () => setSize(compact ? 128 : mq.matches ? 176 : 144);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [compact]);
  useEffect(() => {
    if (!verifyUrl) return undefined;
    let cancelled = false;
    const ecLevel = verifyUrl.length > 200 ? 'H' : 'M';
    QRCode.toDataURL(verifyUrl, {
      width: size,
      margin: 1,
      errorCorrectionLevel: ecLevel,
      color: { dark: '#0a0a0b', light: '#ffffff' },
    })
      .then((u) => {
        if (!cancelled) setDataUrl(u);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [verifyUrl, size]);

  const dimClass = size <= 128 ? 'w-32 h-32' : size <= 144 ? 'w-36 h-36' : 'w-44 h-44';

  if (!verifyUrl) {
    return (
      <div className={`${dimClass} rounded-md border border-[#262629] flex items-center justify-center p-2 shrink-0`}>
        <p className="text-[10px] text-center text-gray-500">QR unavailable — refresh tickets online</p>
      </div>
    );
  }

  if (!dataUrl) {
    return <div className={`${dimClass} rounded-md bg-white/10 animate-pulse shrink-0`} />;
  }

  return (
    <div className="flex flex-col items-center sm:items-end gap-1 shrink-0">
      {eventCode ? (
        <p className="text-xs font-bold font-mono tracking-widest text-[var(--sec-accent)] text-center sm:text-right">
          {eventCode}
        </p>
      ) : null}
      <div className={`relative ${dimClass} shrink-0`}>
        <img src={dataUrl} alt="" className="w-full h-full rounded-md bg-white p-1 object-contain" />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-5">
          <img
            src="/sec-logo.png"
            alt=""
            className="w-9 h-9 object-contain drop-shadow-md rounded-sm bg-white/90 p-0.5"
            onError={(e) => {
              e.currentTarget.src = '/Logo/sec-email-logo-transparent.png';
            }}
          />
        </div>
      </div>
    </div>
  );
}
