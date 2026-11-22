import { useVirtualizer, defaultRangeExtractor } from "@tanstack/react-virtual";
import { useRef, useState, useEffect, type ReactNode } from "react";
/** Large groups retain only the visible rows and any currently focused row. */
export function CatalogRows({
  ids,
  label,
  children,
}: {
  ids: string[];
  label: string;
  children: (index: number) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const virtual = ids.length > 100;
  const rows = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 76,
    getItemKey: (index) => ids[index]!,
    overscan: 4,
    enabled: virtual,
    initialRect: { width: 600, height: 456 },
    useFlushSync: false,
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...(focused !== null && focused < ids.length ? [focused] : []),
        ]),
      ].sort((a, b) => a - b),
  });
  const signature = ids.join("\n");
  useEffect(() => {
    setFocused(null);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [signature]);
  if (!virtual)
    return (
      <div className="catalog-rows">
        {ids.map((id, index) => (
          <div key={id}>{children(index)}</div>
        ))}
      </div>
    );
  return (
    <div
      ref={scroll}
      className="catalog-virtual-scroll"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <div
        style={{
          height: rows.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {rows.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={rows.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
            onFocusCapture={() => setFocused(row.index)}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setFocused(null);
            }}
          >
            {children(row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
