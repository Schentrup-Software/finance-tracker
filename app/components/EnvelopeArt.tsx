/**
 * A cash envelope with bills peeking out of the top. The more cash is left in
 * the envelope, the higher the bills stick out; an empty envelope is sealed.
 * Colours come from the surrounding .c-<name> class (--c and --cd).
 */
export function EnvelopeArt({ fullness, overspent }: { fullness: number; overspent?: boolean }) {
  const f = Math.max(0, Math.min(1, fullness));
  const empty = f <= 0.001;
  // Bills rise from y=58 (tucked in) to y=10 (sticking right out).
  const billTop = 58 - 48 * f;

  return (
    <svg viewBox="0 0 120 100" className="block h-auto w-full" aria-hidden="true">
      {/* back of the envelope */}
      <rect x="10" y="40" width="100" height="56" rx="12" fill="var(--cd)" />
      {!empty && (
        <g>
          <rect x="22" y={billTop + 6} width="76" height="60" rx="6" fill="#86ce9a" stroke="#5fae78" strokeWidth="3" />
          <rect x="18" y={billTop} width="84" height="60" rx="6" fill="#beebc8" stroke="#86ce9a" strokeWidth="3" />
          <circle cx="60" cy={billTop + 16} r="8" fill="none" stroke="#86ce9a" strokeWidth="3" />
          <text x="60" y={billTop + 20.5} textAnchor="middle" fontSize="12" fontWeight="900" fill="#5fae78">$</text>
        </g>
      )}
      {/* front pocket */}
      <path d="M10 52 60 76 110 52 V84 a12 12 0 0 1 -12 12 H22 a12 12 0 0 1 -12 -12Z"
        fill="var(--c)" stroke="var(--cd)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M10 92 46 68M110 92 74 68" stroke="var(--cd)" strokeWidth="3" strokeLinecap="round" />
      {/* the flap: open when there's cash, closed when empty */}
      {empty ? (
        <path d="M12 44 60 74 108 44" fill="var(--c)" stroke="var(--cd)" strokeWidth="3" strokeLinejoin="round" />
      ) : (
        <path d="M14 42 60 18 106 42" fill="none" stroke="var(--cd)" strokeWidth="3" strokeLinejoin="round" opacity=".8" />
      )}
      {overspent && (
        <g>
          <circle cx="100" cy="30" r="12" fill="#ffb8b8" stroke="#f08f8f" strokeWidth="3" />
          <text x="100" y="35" textAnchor="middle" fontSize="15" fontWeight="900" fill="#6a5d7b">!</text>
        </g>
      )}
    </svg>
  );
}
