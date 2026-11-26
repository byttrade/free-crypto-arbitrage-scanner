// Справка: интерактивный тур по панели (сам открывается при первом запуске), меню «?» и окно горячих клавиш.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n, type Lang } from "./i18n";
import { CHAPTERS } from "./tour";

const SEEN = "arb.tour";

const UI = {
  ru: { help: "Справка", tour: "Весь тур", chapters: "По вкладкам", keys: "Горячие клавиши", next: "Далее", back: "Назад", skip: "Пропустить", done: "Готово", close: "Закрыть", of: "из" },
  en: { help: "Help", tour: "Full tour", chapters: "By tab", keys: "Hotkeys", next: "Next", back: "Back", skip: "Skip", done: "Done", close: "Close", of: "of" },
};

const HOTKEYS: Record<Lang, [string, string][][]> = {
  ru: [
    [["B", "купить по рынку"], ["S", "продать по рынку"], ["X", "закрыть позицию"], ["H", "закрыть половину"]],
    [["C", "снять свои ордера на открытых стаканах"], ["Esc", "очистить поиск, закрыть окно"]],
    [["клик по уровню", "лимитка на этой цене"], ["клик по своей", "снять ордер"], ["перетащить свою", "перенести ордер"], ["Shift + клик", "TP или SL позиции (лесенка графика)"]],
    [["← →", "шаги тура"]],
  ],
  en: [
    [["B", "buy at market"], ["S", "sell at market"], ["X", "close the position"], ["H", "close half"]],
    [["C", "cancel your orders on the open books"], ["Esc", "clear search, close a window"]],
    [["click a level", "limit order at that price"], ["click your order", "cancel it"], ["drag your order", "move it"], ["Shift + click", "position TP or SL (chart ladder)"]],
    [["← →", "tour steps"]],
  ],
};
const GROUP: Record<Lang, string[]> = {
  ru: ["Графики, режим «в один клик»", "Везде", "Стакан и лесенка", "Тур"],
  en: ["Charts, one-click mode", "Anywhere", "Book and ladder", "Tour"],
};

/** Первый запуск: тур ещё не пройден и не пропущен. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return true; // хранилище недоступно — не навязываем тур на каждом открытии
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {
    /* приватное окно — тур просто покажется снова */
  }
}

export function Tour({ tab, chapter, onTab, onClose }: { tab: string; chapter?: string; onTab: (tab: string) => void; onClose: () => void }) {
  const { lang } = useI18n();
  const steps = CHAPTERS[lang].filter((c) => !chapter || c.id === chapter).flatMap((c) => c.steps.map((s) => ({ ...s, ch: c.title })));
  const ui = UI[lang];
  const [i, setI] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const start = useRef(tab);
  const card = useRef<HTMLDivElement>(null);
  const step = steps[i];

  const finish = () => {
    markSeen();
    onTab(start.current);
    onClose();
  };

  useEffect(() => {
    if (step.tab && step.tab !== tab) onTab(step.tab);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Блок появляется после смены вкладки — ищем его несколько кадров; потом следим за его размером
  // (стакан и график дорисовываются после загрузки) и за размером окна.
  useLayoutEffect(() => {
    let raf = 0;
    let tries = 0;
    const ro = new ResizeObserver(() => measure());
    let el: Element | null = null;
    const measure = () => el && setBox(el.getBoundingClientRect());
    const find = () => {
      // шагу нужна выбранная строка (связка, пара) — выбираем первую, если пользователь ещё не выбрал
      if (step.prep && !document.querySelector(step.prep[1])) (document.querySelector(step.prep[0]) as HTMLElement | null)?.click();
      el = step.sel ? document.querySelector(step.sel) : null;
      if (el && el.getBoundingClientRect().width > 0) {
        el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? "start" : "nearest" }); // высокий блок «nearest» не прокручивает
        measure();
        ro.observe(el);
      } else if (step.sel && tries++ < 30) {
        raf = requestAnimationFrame(find);
      } else setBox(null);
    };
    find();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true); // плавная прокрутка к блоку и прокрутка пользователем
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [i, tab, step.sel]);

  useEffect(() => {
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, steps.length - 1));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const W = Math.min(380, window.innerWidth - 32);
  const H = (card.current?.offsetHeight || 260) + 16; // высота с прошлой отрисовки: тексты шагов разной длины
  const pad = 6;
  let pos: React.CSSProperties = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  if (box) {
    const below = box.bottom + 12;
    // снизу или сверху блока; блок во весь экран (таблица, график) — карточка внутри него, у нижнего края
    const top = window.innerHeight - below > H ? below : box.top - 12 > H ? box.top - 12 - H + 16 : Math.max(16, Math.min(box.bottom, window.innerHeight) - H);
    const left = Math.min(Math.max(16, box.left), window.innerWidth - W - 16);
    pos = { left, top };
  }
  const last = i === steps.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {box ? (
        <div className="tour-hole" style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" ref={card} tabIndex={-1} style={{ ...pos, width: W }}>
        <div className="tour-count">{step.ch} · {i + 1} {ui.of} {steps.length}</div>
        <h3 id="tour-title">{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-nav">
          {!last && <button type="button" className="link" onClick={finish}>{ui.skip}</button>}
          <span className="grow" />
          {i > 0 && <button type="button" onClick={() => setI(i - 1)}>{ui.back}</button>}
          <button type="button" className="primary" onClick={() => (last ? finish() : setI(i + 1))}>{last ? ui.done : ui.next}</button>
        </div>
      </div>
    </div>
  );
}

function Hotkeys({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n();
  const ui = UI[lang];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="keys-title" onClick={onClose}>
      <div className="tour-dim" />
      <div className="tour-card keys-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="keys-title">{ui.keys}</h3>
        {HOTKEYS[lang].map((rows, g) => (
          <div key={g} className="keys-group">
            <div className="muted">{GROUP[lang][g]}</div>
            {rows.map(([k, what]) => (
              <div key={k} className="keys-row"><kbd>{k}</kbd><span>{what}</span></div>
            ))}
          </div>
        ))}
        <p className="muted">{lang === "ru" ? "Буквы работают в любой раскладке." : "Letter keys work in any keyboard layout."}</p>
        <div className="tour-nav"><span className="grow" /><button type="button" className="primary" onClick={onClose}>{ui.close}</button></div>
      </div>
    </div>
  );
}

/** Кнопка «?»: тур и горячие клавиши. */
export function HelpMenu({ onTour }: { onTour: (chapter?: string) => void }) {
  const { lang } = useI18n();
  const ui = UI[lang];
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  return (
    <div className="wallet" ref={ref} data-tour="help">
      <button type="button" className={`chip help-btn ${open ? "on" : ""}`} title={ui.help} aria-label={ui.help} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ?
      </button>
      {open && (
        <div className="wallet-drop help-drop">
          <button type="button" className="ghost" onClick={() => { setOpen(false); onTour(); }}>{ui.tour}</button>
          <button type="button" className="ghost" onClick={() => { setOpen(false); setKeys(true); }}>{ui.keys}</button>
          <span className="muted help-sub">{ui.chapters}</span>
          {CHAPTERS[lang].filter((c) => c.id !== "start").map((c) => (
            <button key={c.id} type="button" className="ghost" onClick={() => { setOpen(false); onTour(c.id); }}>{c.title}</button>
          ))}
        </div>
      )}
      {keys && <Hotkeys onClose={() => setKeys(false)} />}
    </div>
  );
}
