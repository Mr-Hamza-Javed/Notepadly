import { memo, useEffect, useRef } from "react";

/**
 * One tooltip element for the whole window, driven by `data-tip` attributes.
 * Works by direct DOM updates, so hovering never renders React.
 */
export const Tooltip = memo(function Tooltip() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    let current: Element | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      el.classList.remove("show");
    };

    const show = (target: Element) => {
      const text = target.getAttribute("data-tip");
      if (!text) return;
      el.textContent = text;
      const r = target.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.max(4, Math.min((r.left + r.right - w) / 2, window.innerWidth - w - 4));
      const below = r.bottom + 6;
      const y = below + h > window.innerHeight - 4 ? r.top - h - 6 : below;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.classList.add("show");
    };

    const over = (e: PointerEvent) => {
      const target = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (target === current) return;
      hide();
      if (!target) return;
      current = target;
      timer = window.setTimeout(() => show(target), 550);
    };

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return <div ref={ref} className="tooltip" role="tooltip" />;
});
