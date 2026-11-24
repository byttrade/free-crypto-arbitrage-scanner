import { useLayoutEffect, useRef, useState } from "react";

type Item = { id: string; label: string };

export function Tabs({
  items,
  value,
  onChange,
}: {
  items: Item[];
  value: string;
  onChange: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [pill, setPill] = useState({ x: 0, y: 0, w: 0, h: 0, ready: false });

  useLayoutEffect(() => {
    const list = listRef.current;
    const btn = refs.current.get(value);
    if (!list || !btn) return;
    const place = () => {
      setPill({
        x: btn.offsetLeft,
        y: btn.offsetTop,
        w: btn.offsetWidth,
        h: btn.offsetHeight,
        ready: btn.offsetWidth > 2,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(list);
    ro.observe(btn);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div className={`tray ${pill.ready ? "ready" : ""}`} ref={listRef}>
      <span
        className="pill"
        style={{
          width: pill.w,
          height: pill.h,
          transform: `translate3d(${pill.x}px, ${pill.y}px, 0)`,
          opacity: pill.ready ? 1 : 0,
        }}
      />
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          ref={(el) => {
            if (el) refs.current.set(item.id, el);
            else refs.current.delete(item.id);
          }}
          className={item.id === value ? "on" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
