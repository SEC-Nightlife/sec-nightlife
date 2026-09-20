import { Capacitor } from '@capacitor/core';

/** Remove the inline HTML boot splash once React has painted. */
export function removeBootSplash() {
  const el = document.getElementById('sec-boot-splash');
  if (el) {
    el.classList.add('sec-boot-splash--out');
    window.setTimeout(() => el.remove(), 420);
  }

  if (Capacitor.isNativePlatform()) {
    void import('@/lib/capacitorNative').then(({ hideNativeSplash }) => {
      void hideNativeSplash();
    });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    window.setTimeout(removeBootSplash, 5000);
  });
}
