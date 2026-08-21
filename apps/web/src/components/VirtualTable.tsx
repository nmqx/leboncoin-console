import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface Column<T> {
  key: string;
  header: string;
  width: string; // valeur grid-template-columns (ex: "2fr", "90px")
  align?: "right";
  sortKey?: string;
  render: (row: T) => ReactNode;
}

interface Props<T> {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  activeKey?: string | null;
  onRowClick?: (row: T) => void;
  sort?: { key: string; dir: "asc" | "desc" } | null;
  onSort?: (key: string) => void;
  onRowKeyDown?: (e: React.KeyboardEvent, index: number) => void;
  focusIndex?: number | null;
}

/**
 * Tableau virtualisé, rangées 38 px, en-têtes triables. La grille est en
 * div (role table) : cohérent à haute densité et compatible virtualisation.
 */
export default function VirtualTable<T>({
  rows, columns, rowKey, activeKey, onRowClick, sort, onSort, onRowKeyDown, focusIndex,
}: Props<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 38,
    overscan: 14,
  });

  const gridTemplate = columns.map((c) => c.width).join(" ");

  return (
    <div className="table-wrap" ref={parentRef} role="grid" aria-rowcount={rows.length}>
      <div role="rowgroup" style={{ display: "grid", gridTemplateColumns: gridTemplate, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-1)", borderBottom: "1px solid var(--line)" }}>
        {columns.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            className={c.sortKey ? "sortable" : ""}
            style={{
              height: 30, display: "flex", alignItems: "center", padding: "0 10px",
              fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em",
              color: "var(--text-3)", justifyContent: c.align === "right" ? "flex-end" : "flex-start",
              cursor: c.sortKey && onSort ? "pointer" : "default", userSelect: "none",
            }}
            onClick={() => c.sortKey && onSort?.(c.sortKey)}
            aria-sort={sort && c.sortKey && sort.key === c.sortKey ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
          >
            {c.header}
            {sort && c.sortKey && sort.key === c.sortKey ? <span className="sort-ind">{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
          </div>
        ))}
      </div>
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index]!;
          const active = activeKey != null && rowKey(row) === activeKey;
          return (
            <div
              key={rowKey(row)}
              role="row"
              aria-selected={active}
              tabIndex={focusIndex === v.index ? 0 : -1}
              onClick={() => onRowClick?.(row)}
              onKeyDown={(e) => onRowKeyDown?.(e, v.index)}
              style={{
                display: "grid",
                gridTemplateColumns: gridTemplate,
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: v.size,
                transform: `translateY(${v.start}px)`,
                alignItems: "center",
                cursor: onRowClick ? "pointer" : "default",
                background: active ? "color-mix(in oklch, var(--accent-dim) 40%, var(--bg-1))" : undefined,
                boxShadow: active ? "inset 2px 0 0 var(--accent)" : undefined,
              }}
            >
              {columns.map((c) => (
                <div
                  key={c.key}
                  role="gridcell"
                  className={c.align === "right" ? "num" : undefined}
                  style={{ padding: "0 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}
                >
                  {c.render(row)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
