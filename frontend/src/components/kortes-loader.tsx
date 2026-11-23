import { cn } from "@/lib/utils";

/**
 * The Kortes scissors drawing themselves and snipping: the app's loading mark.
 * The dark blade follows the text colour (currentColor), so it shows on light,
 * dark and photo backgrounds alike. Animation lives in globals.css (.kl-*),
 * and stops for people who ask for reduced motion.
 */
export function KortesLoader({
  size = 56,
  label = "Carregando",
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={cn("kortes-loader shrink-0", className)}
    >
      <g className="kl-wrap">
        <g className="kl-gray" stroke="#9D9FA2" strokeWidth="16.6" fill="none">
          <circle cx="44.3" cy="61.1" r="25" className="kl-circle" />
          <line x1="44.3" y1="86.1" x2="103.5" y2="86.1" className="kl-stem" />
          <line x1="150" y1="86.1" x2="180.7" y2="86.1" strokeLinecap="round" className="kl-tip" />
        </g>
        <g className="kl-dark" stroke="currentColor" strokeWidth="16.6" fill="none">
          <circle cx="77.7" cy="147.3" r="25" className="kl-circle" />
          <line x1="60.02" y1="129.62" x2="156.34" y2="33.3" strokeLinecap="round" className="kl-blade" />
        </g>
      </g>
    </svg>
  );
}

/** A centred loader with an optional line under it, for whole areas that load. */
export function KortesLoading({
  label,
  size = 64,
  className,
}: {
  label?: string;
  size?: number;
  className?: string;
}) {
  return (
    <div role="status" className={cn("flex flex-col items-center justify-center gap-3 text-center", className)}>
      <KortesLoader size={size} label={label || "Carregando"} />
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : <span className="sr-only">Carregando…</span>}
    </div>
  );
}
