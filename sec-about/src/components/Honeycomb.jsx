export default function Honeycomb({ className = '' }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 opacity-[0.07] ${className}`}
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='100' viewBox='0 0 28 50'%3E%3Cpath fill='none' stroke='%23C0C0C0' stroke-width='0.6' d='M14 0l14 8v16l-14 8L0 24V8z'/%3E%3C/svg%3E")`,
        backgroundSize: '56px 100px',
        maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
      }}
    />
  )
}
