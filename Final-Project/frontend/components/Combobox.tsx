"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export function Combobox<T>({
  value,
  onChange,
  items,
  itemKey,
  itemLabel,
  itemSubtitle,
  placeholder = "Выбрать…",
}: {
  value: T | null;
  onChange: (v: T | null) => void;
  items: T[];
  itemKey: (it: T) => string;
  itemLabel: (it: T) => string;
  itemSubtitle?: (it: T) => string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    if (!q) return items.slice(0, 200);
    const lo = q.toLowerCase();
    return items
      .filter(
        (it) =>
          itemLabel(it).toLowerCase().includes(lo) ||
          (itemSubtitle?.(it).toLowerCase().includes(lo) ?? false)
      )
      .slice(0, 200);
  }, [q, items, itemLabel, itemSubtitle]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input flex items-center justify-between"
      >
        <span className="truncate text-left">
          {value ? itemLabel(value) : <span className="text-ink-400">{placeholder}</span>}
        </span>
        <ChevronDown className="h-4 w-4 text-ink-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-xl border border-line bg-white shadow-cardLg">
          <div className="border-b border-line p-2">
            <div className="flex items-center gap-2 rounded-lg bg-ink-50 px-2 py-1.5">
              <Search className="h-4 w-4 text-ink-400" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Поиск…"
                className="flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-sm text-ink-500">Ничего не найдено</div>
            )}
            {filtered.map((it) => (
              <button
                key={itemKey(it)}
                onClick={() => {
                  onChange(it);
                  setOpen(false);
                  setQ("");
                }}
                className="block w-full px-3 py-2 text-left hover:bg-ink-50"
              >
                <div className="text-sm text-ink-900">{itemLabel(it)}</div>
                {itemSubtitle && (
                  <div className="text-[11px] text-ink-500 truncate">{itemSubtitle(it)}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
