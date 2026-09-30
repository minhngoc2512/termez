/** Logo Termez: chữ T, thân chữ là con trỏ terminal (xem electron/resources/logo.svg). */
export function Logo({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#0f172a" />
      <rect x="95" y="110" width="322" height="73" rx="18" fill="#22c55e" />
      <rect x="219" y="205" width="73" height="197" rx="14" fill="#4ade80" />
      <rect x="322" y="351" width="80" height="26" rx="7" fill="#334155" />
    </svg>
  );
}
