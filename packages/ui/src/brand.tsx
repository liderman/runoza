export const brandMark = new URL("./assets/runoza-mark.png", import.meta.url)
  .href;
export function BrandLogo({
  compact = false,
}: {
  compact?: boolean;
  theme?: "light" | "dark";
}) {
  return (
    <span className="brand-logo" role="img" aria-label="Runóza">
      <img src={brandMark} alt="" width={36} height={36} />
      {!compact && <span>Runóza</span>}
    </span>
  );
}
