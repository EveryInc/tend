import { type RefObject, useEffect, useRef, useState } from "react";

export function useActiveCard(pageRef: RefObject<HTMLElement>, cardIds: string[]) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const activeCardIdRef = useRef(activeCardId);
  activeCardIdRef.current = activeCardId;

  useEffect(() => {
    let scheduled: number | null = null;
    const pickActive = () => {
      const readingLine = window.innerHeight * 0.42;
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const id of cardIds) {
        const card = pageRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
        if (!card) continue;
        const rect = card.getBoundingClientRect();
        if (rect.bottom < 80 || rect.top > window.innerHeight - 90) continue;
        const distance = Math.abs((rect.top + rect.bottom) / 2 - readingLine);
        if (distance < bestDistance) {
          best = id;
          bestDistance = distance;
        }
      }
      setActiveCardId(best);
    };
    const update = () => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = null;
        pickActive();
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // Switching versions must preserve the user's explicit card selection.
    if (!activeCardIdRef.current || !cardIds.includes(activeCardIdRef.current)) update();
    return () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [cardIds, pageRef]);

  const navTo = (offset: number) => {
    if (!cardIds.length) return;
    const current = activeCardId ? cardIds.indexOf(activeCardId) : -1;
    const index = Math.max(0, Math.min(cardIds.length - 1, current + offset));
    const id = cardIds[index];
    pageRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveCardId(id);
  };

  return { activeCardId, setActiveCardId, navTo };
}
