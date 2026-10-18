// The Thun Murex mark, traced from the logo artwork (Geometric Black TM Monogram Logo.png). It
// takes the text color, so it's black on the light theme and white on the dark one.
export const LOGO_VIEWBOX = "0 0 809 809";
export const LOGO_PATH =
  "M407.5 41 L630.5 165 L485.5 245 L406.5 201 L292.5 261 L292.5 663 L163.5 590 L165.5 310 L162.5 309 L30.5 375 L30.5 246 Z M736.5 241 L773.5 260 L778.5 266 L777.5 579 L654.5 651 L655.5 448 L647.5 450 L546.5 509 L518.5 493 L517.5 698 L395.5 768 L396.5 308 L429.5 292 L539.5 354 Z";

export function Logo({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className}
      viewBox={LOGO_VIEWBOX}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path fill="currentColor" d={LOGO_PATH} />
    </svg>
  );
}
