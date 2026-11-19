export default function PhoneFrame({ children, className = '' }) {
  return (
    <div className={`relative mx-auto w-full max-w-[280px] ${className}`}>
      <div
        className="pointer-events-none absolute -inset-8 rounded-[3rem] opacity-70 blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 50% 30%, rgba(192,192,192,0.18), transparent 65%)',
        }}
      />
      <div className="relative overflow-hidden rounded-[1.85rem] border border-[#2a2a2a] bg-[#0a0a0a] p-[7px] shadow-[0_24px_60px_rgba(0,0,0,0.65)]">
        <div className="absolute left-1/2 top-2 z-10 h-4 w-20 -translate-x-1/2 rounded-full bg-black/80" />
        <div className="overflow-hidden rounded-[1.45rem] bg-black">{children}</div>
      </div>
    </div>
  )
}
