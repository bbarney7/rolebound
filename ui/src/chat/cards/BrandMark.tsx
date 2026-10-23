export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="28"
      height="28"
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      <rect width="28" height="28" rx="7" fill="var(--brand-tile, #161B2E)" />
      <path
        d="M9 21V13a4 4 0 0 1 4-4h4"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="20.5" cy="9" r="2.6" fill="var(--needs, #F5B342)" />
    </svg>
  );
}
