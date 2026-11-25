// The Kortes mark: the scissors of the logo, drawn so they read on light and dark.

export function Scissors({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden className={className}>
      <g stroke="#9D9FA2" strokeWidth="16.6" fill="none">
        <circle cx="44.3" cy="61.1" r="25" />
        <line x1="44.3" y1="86.1" x2="103.5" y2="86.1" />
        <line x1="150" y1="86.1" x2="180.7" y2="86.1" strokeLinecap="round" />
      </g>
      <g stroke="currentColor" strokeWidth="16.6" fill="none">
        <circle cx="77.7" cy="147.3" r="25" />
        <line x1="60.02" y1="129.62" x2="156.34" y2="33.3" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** Small line icons (24px, stroke = currentColor) for the panel and account pages. */
const ICONS = {
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  megaphone: <><path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  arrowLeft: <path d="M19 12H5m7 7-7-7 7-7" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  pc: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></>,
  key: <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></>,
  note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8" /></>,
  receipt: <><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .67V2l-3 2-3-2-3 2-3-2-3 2z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}
