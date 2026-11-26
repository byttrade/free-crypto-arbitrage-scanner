// Тексты тура по панели: главы по вкладкам, в каждой — шаги с подсвечиваемым блоком.
import type { Lang } from "./i18n";

export type Step = {
  tab?: string; // вкладка, на которую тур переключает перед шагом
  sel?: string; // блок для подсветки; нет на экране — карточка по центру
  prep?: [click: string, unless: string]; // кликнуть первое (выбрать строку), если второго ещё нет
  title: string;
  body: string;
};
export type Chapter = { id: string; title: string; steps: Step[] };

const PICK_SPREAD: Step["prep"] = [".table-wrap tbody tr", ".table-wrap tbody tr.sel"];
const PICK_PAIR: Step["prep"] = [".table-wrap tbody tr", ".pair-hist-cap b"];

export const CHAPTERS: Record<Lang, Chapter[]> = {
  ru: [
    {
      id: "start", title: "Начало", steps: [
        { title: "Добро пожаловать в ArbDesk", body: "Тур по всем вкладкам и настройкам, около пяти минут. Листайте «Далее» или стрелками ← →. Пропустить можно в любой момент; отдельные главы — в меню «?» вверху." },
        { sel: ".tray", title: "Вкладки", body: "Спреды — разница цен одной монеты между биржами. Пары — две монеты, которые ходят вместе. Фандинг — ставки перпов. Графики — скальпинг с лесенкой. Алерты, журнал связок и дневник с PnL." },
        { sel: ".search-box", title: "Поиск", body: "Монета или биржа: BTC, Binance. Работает на спредах, парах, фандинге и алертах. Esc очищает поле." },
      ],
    },
    {
      id: "cross", title: "Спреды", steps: [
        { tab: "cross", sel: ".flt-venues", title: "Биржи", body: "Обе ноги связки — только на отмеченных биржах; ничего не отмечено — все. Точка на логотипе — состояние биржи: зелёная — котировки свежие (до 15 с), жёлтая — запаздывают (до минуты), красная — старше минуты. Наведите, чтобы увидеть подробности." },
        { tab: "cross", sel: ".filters", title: "Фильтры", body: "Рынок: спот или перп. Котировка: USDT или USDC. Спред ≥ и объём ≥ — отсечь мелочь. «Живёт ≤» — только свежие спреды. «Только net > 0» — прибыльные после комиссий. «Скрыть закрытый ввод/вывод» — без монет, которые нельзя перевести между биржами. «★ только избранное». «Сброс» возвращает всё." },
        { tab: "cross", sel: ".table-wrap thead", title: "Столбцы", body: "Клик по заголовку сортирует: сначала по убыванию, второй клик — по возрастанию, третий — как пришло. «Купить» — биржа и ask, «продать» — биржа и bid. Спред — разница в процентах. Нетто — спред минус taker-комиссии обеих ног на вход и выход и запас на проскальзывание." },
        { tab: "cross", sel: ".table-wrap tbody tr", title: "Строка спреда", body: "★ — в избранное: по монете придут алерты. Под ценами ног — ставка фандинга и её период. Под спредом — спред на объём $1K по стакану, сколько связка живёт и средний спред. Под нетто — Δ фандинга за 8 ч и ближайшая выплата. Зелёный фон — спред и фандинг работают в одну сторону. Предупреждение о цене — скорее всего, это разные монеты с одним тикером." },
        { tab: "cross", sel: ".table-wrap tbody tr .acts", title: "Кнопки в строке", body: "«Купить» и «Продать» открывают связку и сразу заполняют тикет нужной ноги в стакане ниже. Клик по самой строке просто открывает связку справа." },
        { tab: "cross", sel: ".arb-banner", prep: PICK_SPREAD, title: "Связка", body: "Слева — где покупаем (ask), справа — где продаём (bid), в центре — живой спред на сумму тикета. Ниже сводка: спред, нетто (наведите — формула), комиссии, фандинг каждой ноги и период, Δ 8 ч, ближайшая выплата, возраст и средний спред." },
        { tab: "cross", sel: ".pair-exec", prep: PICK_SPREAD, title: "Открыть связку", body: "Одна кнопка — обе ноги сразу IOC-лимитками на одинаковое число монет; размер ограничен свободным балансом. ± — допуск цены: насколько хуже текущей можно исполниться. Что не исполнилось, не висит в стакане. Результат — во вкладке «Связки»." },
        { tab: "cross", sel: ".coin-strip", prep: PICK_SPREAD, title: "На всех биржах", body: "Та же монета на других биржах: bid и ask. Клик по цене делает биржу ногой покупки или продажи — так можно перебрать варианты, не возвращаясь к таблице." },
        { tab: "cross", sel: ".minis-wrap", prep: PICK_SPREAD, title: "Графики связки", body: "Спред во времени и свечи каждой ноги. Таймфрейм 5м, 1ч, 4ч, 1д; EMA 200 на спреде; ⛶ — развернуть. Полоска внизу тянется — графики выше или ниже." },
        { tab: "cross", sel: ".books", prep: PICK_SPREAD, title: "Стаканы ног", body: "Зелёная кнопка покупает по лучшему ask, красная продаёт по лучшему bid; сумма — в USDT или USD, кнопками ниже (подсказка покажет, сколько это монет). Клик по уровню — лимитка, клик по своей — снять, перетащить — перенести, C — снять все. ×1…×50 — группировка тиков. Под стаканом — позиция с PnL и кнопками закрытия, ниже — лента сделок (тянется вверх)." },
        { tab: "cross", sel: ".blotter", title: "Ордера и позиции", body: "Появляется, когда есть ордера или позиции не на открытых стаканах. ▾ сворачивает список, 🔔 — звук и уведомление об исполнении. Позицию можно закрыть 25%, 50% или целиком, имя — открыть на графике." },
        { tab: "cross", sel: ".split-x", title: "Ширина", body: "Перетащите разделитель, чтобы дать больше места таблице или связке." },
      ],
    },
    {
      id: "pairs", title: "Пары", steps: [
        { tab: "pairs", sel: ".filters", title: "Пары: идея", body: "Статарбитраж: две монеты, которые обычно ходят вместе. Когда разрыв между ними необычно велик, его ставят на схождение: одну покупают, другую шортят. Считается по 4-часовым свечам перпов. Фильтры: corr ≥ — минимальная корреляция, |z| ≥ — насколько велик разрыв сейчас." },
        { tab: "pairs", sel: ".table-wrap", title: "Столбцы", body: "Y / X — пара. corr — корреляция доходностей. coint p — проверка коинтеграции: чем меньше, тем надёжнее связь (ниже 0.05 — хорошо). |z| — разрыв в стандартных отклонениях, красный от 2 — зона входа. «Живёт» — полураспад спреда (как быстро сходится) и сколько держится коинтеграция. «Отдача» — история: доля схождений от |z| 2 до 0.5 · число сделок · среднее время." },
        { tab: "pairs", sel: ".pair-hist", prep: PICK_PAIR, title: "История пары", body: "z-оценка спреда пары во времени: видно, как часто и как быстро разрыв сходился. EMA 200 — тренд спреда. Прокрутите влево — подгрузится более ранняя история." },
        { sel: ".foot", title: "Расчёт пар", body: "Пары пересчитываются в фоне; статус — в подвале слева: «считаю N монет», «готово» или «мало ликвидных перпов»." },
      ],
    },
    {
      id: "funding", title: "Фандинг", steps: [
        { tab: "funding", sel: ".filters", title: "Фильтры фандинга", body: "|Фандинг| ≥ — только заметные ставки. Период: выплата раз в 1, 4 или 8 часов. Знак: плюс — лонги платят шортам, минус — наоборот. Объём ≥ и ★ избранное." },
        { tab: "funding", sel: ".table-wrap", title: "Таблица", body: "Биржа, монета, ставка за период, период, basis — насколько перп дороже (плюс) или дешевле спота, суточный объём. Сравнивайте ставки с учётом периода: 0.01% за 1 ч — это 0.08% за 8 ч. Сортировка — кликом по заголовку." },
      ],
    },
    {
      id: "chart", title: "Графики", steps: [
        { tab: "chart", sel: ".coin-pick", title: "Монета и рынок", body: "Введите монету и нажмите «Открыть» или Enter. perp или spot. Сюда же ведёт имя позиции в списке ордеров и позиций." },
        { tab: "chart", sel: ".venue-pick", title: "Биржа", body: "Биржи, где есть эта монета. Переключение меняет график, стакан и ключ для торговли." },
        { tab: "chart", sel: ".tf-bar", title: "Таймфрейм", body: "1m, 5m, 15m, 1h, 4h, 1d. Прокрутка колесом — масштаб, перетаскивание — сдвиг по времени." },
        { tab: "chart", sel: ".ind-wrap", title: "Индикаторы", body: "До четырёх EMA со своими периодами, SMA, VWAP (сброс в 00:00 UTC), полосы Боллинджера 20, 2, объём, RSI 14 и MACD 12, 26, 9 — отдельными панелями под свечами. «Сброс» — как было. Выбор запоминается." },
        { tab: "chart", sel: ".scalp-main", title: "График", body: "Сверху легенда: OHLC свечи и значения индикаторов. На графике — линия входа с PnL после комиссий, ваши лимитки и пунктиром TP и SL." },
        { tab: "chart", sel: ".ticket", title: "Тикет", body: "Ключ (demo или LIVE), 🔔 — звук об исполнении. Сумма в USDT и быстрые суммы. «Купить/Продать по рынку» — с лучшей ценой на кнопке. «Купить по bid / Продать по ask» — лимитка только-мейкер: комиссия ниже, биржа отменит её, если она съест стакан." },
        { tab: "chart", sel: ".one-click", title: "В один клик", body: "Ордера без окон подтверждения, работают клавиши B — купить, S — продать, X — закрыть, H — закрыть половину (в любой раскладке). Сам выключается, когда закроете вкладку. На LIVE-ключе — осторожно." },
        { tab: "chart", sel: ".pos-card", title: "Позиция", body: "Сторона, размер, вход, PnL после комиссий (наведите — расклад; на demo — по цене маркировки demo). Ликвидация и плечо. Закрыть 25/50/75% или всё по рынку; «Закрыть лимиткой по лучшей» — reduce-only мейкером. TP и SL — ордера на бирже: цена и «Поставить», × — снять." },
        { tab: "chart", sel: ".ladder-mini", title: "Лесенка", body: "Клик — лимитка на этой цене на сумму из тикета (ниже рынка — покупка, выше — продажа). Клик по своей — снять, перетащить — перенести, Shift+клик — TP или SL позиции. ×5, ×10, ×50 — группировка тиков на монетах с мелким шагом." },
      ],
    },
    {
      id: "alerts", title: "Алерты", steps: [
        { tab: "alerts", sel: ".filters", title: "Типы алертов", body: "Порог — спред выше заданного. Скорость — спред резко расширился за окно в секундах. Фандинг — ставка выше порога. Избранное — монеты со ★, когда нетто выше своего порога, без фильтра объёма." },
        { tab: "alerts", sel: ".alerts", title: "Лента алертов", body: "Новые сверху. Кнопка «Уведомления браузера» — всплывающие сообщения, даже когда вкладка свёрнута. Пороги и Telegram — в настройках Telegram вверху справа." },
      ],
    },
    {
      id: "journal", title: "Связки", steps: [
        { tab: "journal", sel: ".table-wrap", title: "Журнал связок", body: "Каждая связка, открытая кнопкой ⇄: время, пара (demo или LIVE), ноги — биржа, объём и цена, размер, вход и PnL. Статусы: открыта, перекос (ноги исполнились по-разному), закрыта, не исполнилась, закрывается." },
        { tab: "journal", sel: ".table-wrap", title: "Действия", body: "«Догнать» — добрать отстающую ногу до исполненной. «Выровнять» — закрыть лишнее на исполненной. «Закрыть» — обе ноги IOC-лимитками в пределах допуска. «Отметить закрытой» — если закрыли руками на бирже или была ликвидация: PnL оценивается по текущей цене. «Убрать» — когда ничего не исполнилось." },
      ],
    },
    {
      id: "diary", title: "Дневник", steps: [
        { tab: "diary", sel: ".dactions", title: "Сделки", body: "«Добавить сделку» вручную: время, пара, рынок, сторона, объём, вход и выход, комиссии, фандинг, плечо, стратегия, теги, заметка. «Импорт CSV» — выгрузка истории сделок или закрытого PnL с биржи; «Шаблон CSV» — образец. Экспорт CSV и «Отчёт / PDF» для печати. Связки из терминала попадают сюда сами." },
        { tab: "diary", sel: ".dfilters", title: "Фильтры", body: "Период: 7 дней, 30, 90, с начала года, год, всё. Стратегия, биржа, рынок, монета — все цифры и графики ниже пересчитываются." },
        { tab: "diary", sel: ".kpis", title: "Показатели", body: "Итоговый PnL и матожидание на сделку, доля прибыльных, профит-фактор, максимальная просадка и серии, средняя прибыль и убыток, лучшая и худшая, комиссии и фандинг, среднее удержание, нереализованный PnL открытых позиций." },
        { tab: "diary", sel: ".dcharts", title: "Графики дневника", body: "Кривая капитала, PnL по дням (календарь) и месяцам, по стратегиям, биржам, монетам, дням недели, рынкам, лонг и шорт. Наведите на столбец — число сделок и доля прибыльных." },
        { tab: "diary", sel: ".dtable", title: "Таблица сделок", body: "Все сделки периода: изменить или удалить. Источник — терминал, CSV или ручной ввод." },
      ],
    },
    {
      id: "setup", title: "Настройки", steps: [
        { tab: "cross", sel: "[data-tour=keys]", title: "API-ключи", body: "Биржа, ключ, секрет и пароль API (OKX, Bitget, KuCoin, BloFin), demo или live. Ключи хранятся только на вашем компьютере, зашифрованные вашим секретом шифрования: без него баланс скрыт — «Открыть баланс». Начните с demo: всё как по-настоящему, без денег. Для live достаточно прав на торговлю — без вывода." },
        { tab: "cross", sel: "[data-tour=telegram]", title: "Telegram и пороги", body: "Создайте бота у @BotFather, отправьте ему /start, впишите токен и chat id, «Тест». Тут же пороги алертов: спред %, расширение % за окно, пауза между повторами, мин. объём, фандинг %, лимит сообщений в минуту. И расчёт: макс. возраст котировки, запас на проскальзывание, объём для спреда по стакану, порог нетто для ★." },
        { tab: "cross", sel: ".chip.status", title: "Связь", body: "live — котировки идут, рядом их возраст в секундах; off — связь пропала, ордера не отправятся." },
        { tab: "cross", sel: ".upd", title: "Версия и обновления", body: "Версии ArbDesk и bytx. Клик — автообновление: «Вкл», «Сообщать» или «Выкл», и «Проверить и обновить» сейчас. Рядом — «Задать пароль» (вход с других устройств) или «Выйти»." },
        { tab: "cross", sel: ".lang", title: "Язык", body: "EN или RU — весь интерфейс, включая этот тур." },
        { sel: "[data-tour=help]", title: "Справка", body: "«?» — этот тур целиком или по главам и список горячих клавиш. Подсказки есть почти у каждой кнопки и поля: наведите курсор. Удачной торговли!" },
      ],
    },
  ],
  en: [
    {
      id: "start", title: "Start", steps: [
        { title: "Welcome to ArbDesk", body: "A tour of every tab and setting, about five minutes. Use “Next” or the ← → keys. Skip any time; single chapters are in the “?” menu at the top." },
        { sel: ".tray", title: "Tabs", body: "Spreads — one coin's price gap between exchanges. Pairs — two coins that move together. Funding — perp rates. Charts — scalping with a ladder. Alerts, the pair trade journal and the diary with PnL." },
        { sel: ".search-box", title: "Search", body: "A coin or an exchange: BTC, Binance. Works on spreads, pairs, funding and alerts. Esc clears it." },
      ],
    },
    {
      id: "cross", title: "Spreads", steps: [
        { tab: "cross", sel: ".flt-venues", title: "Exchanges", body: "Both legs only on the selected exchanges; none selected — all. The dot on a logo is the exchange state: green — fresh quotes (under 15 s), yellow — lagging (under a minute), red — older than a minute. Hover for details." },
        { tab: "cross", sel: ".filters", title: "Filters", body: "Market: spot or perp. Quote: USDT or USDC. Spread ≥ and volume ≥ cut the noise. “Lives ≤” — only fresh spreads. “Net > 0 only” — profitable after fees. “Hide closed transfers” — drop coins you cannot move between exchanges. “★ watchlist only”. “Reset” clears all." },
        { tab: "cross", sel: ".table-wrap thead", title: "Columns", body: "Click a header to sort: descending, then ascending, then as received. “Buy” — exchange and ask, “sell” — exchange and bid. Spread — the gap in percent. Net — spread minus both legs' taker fees in and out and the slippage reserve." },
        { tab: "cross", sel: ".table-wrap tbody tr", title: "A spread row", body: "★ — add to the watchlist for alerts. Under the leg prices — funding rate and period. Under the spread — the spread for $1K by the book, how long it lives and its average. Under net — 8h funding Δ and the next payout. Green background — spread and funding work the same way. A price warning means it is likely a different coin with the same ticker." },
        { tab: "cross", sel: ".table-wrap tbody tr .acts", title: "Row buttons", body: "“Buy” and “Sell” open the pair and fill that leg's ticket in the book below. Clicking the row itself just opens the pair on the right." },
        { tab: "cross", sel: ".arb-banner", prep: PICK_SPREAD, title: "The pair", body: "Left — where we buy (ask), right — where we sell (bid), center — the live spread for the ticket size. Below: spread, net (hover for the formula), fees, each leg's funding and period, 8h Δ, next payout, age and average spread." },
        { tab: "cross", sel: ".pair-exec", prep: PICK_SPREAD, title: "Open the pair", body: "One button — both legs at once with IOC limits for the same coin count; size is capped by free balance. ± is the price tolerance: how much worse than now a fill may be. Nothing unfilled stays in the book. The result is in “Pair trades”." },
        { tab: "cross", sel: ".coin-strip", prep: PICK_SPREAD, title: "On all exchanges", body: "The same coin elsewhere: bid and ask. Click a price to make that exchange the buy or sell leg — try variants without going back to the table." },
        { tab: "cross", sel: ".minis-wrap", prep: PICK_SPREAD, title: "Pair charts", body: "Spread over time and each leg's candles. 5m, 1h, 4h, 1d; EMA 200 on the spread; ⛶ expands. Drag the bar below to resize." },
        { tab: "cross", sel: ".books", prep: PICK_SPREAD, title: "Leg books", body: "Green buys the best ask, red sells the best bid; size in USDT or USD with the buttons below (the tip shows how many coins). Click a level — limit, click yours — cancel, drag — move, C — cancel all. ×1…×50 group ticks. Below the book — the position with PnL and close buttons, then the trade tape (drag up to enlarge)." },
        { tab: "cross", sel: ".blotter", title: "Orders and positions", body: "Shows up when there are orders or positions outside the open books. ▾ collapses it, 🔔 — sound and notification on fills. Close a position by 25%, 50% or fully; click its name to open the chart." },
        { tab: "cross", sel: ".split-x", title: "Width", body: "Drag the divider to give the table or the pair more room." },
      ],
    },
    {
      id: "pairs", title: "Pairs", steps: [
        { tab: "pairs", sel: ".filters", title: "Pairs: the idea", body: "Stat arb: two coins that usually move together. When the gap is unusually wide, bet on it closing: buy one, short the other. Computed on 4-hour perp candles. Filters: corr ≥ — minimum correlation, |z| ≥ — how wide the gap is now." },
        { tab: "pairs", sel: ".table-wrap", title: "Columns", body: "Y / X — the pair. corr — return correlation. coint p — cointegration test: lower is stronger (below 0.05 is good). |z| — the gap in standard deviations, red from 2 is the entry zone. “Life” — spread half-life (how fast it reverts) and how long cointegration has held. “Payoff” — history: share of reversions from |z| 2 to 0.5 · trades · average hours." },
        { tab: "pairs", sel: ".pair-hist", prep: PICK_PAIR, title: "Pair history", body: "The pair spread's z-score over time: how often and how fast the gap closed. EMA 200 is the spread trend. Scroll left to load older history." },
        { sel: ".foot", title: "Pair scan", body: "Pairs are recomputed in the background; the status is bottom left: “counting N coins”, “ready” or “few liquid perps”." },
      ],
    },
    {
      id: "funding", title: "Funding", steps: [
        { tab: "funding", sel: ".filters", title: "Funding filters", body: "|Funding| ≥ — only notable rates. Period: paid every 1, 4 or 8 hours. Sign: plus — longs pay shorts, minus — the other way. Volume ≥ and ★ watchlist." },
        { tab: "funding", sel: ".table-wrap", title: "Table", body: "Exchange, coin, rate per period, period, basis — how much the perp is above (plus) or below spot, daily volume. Compare rates by period: 0.01% per 1h is 0.08% per 8h. Click a header to sort." },
      ],
    },
    {
      id: "chart", title: "Charts", steps: [
        { tab: "chart", sel: ".coin-pick", title: "Coin and market", body: "Type a coin and press “Open” or Enter. perp or spot. A position name in the orders list also leads here." },
        { tab: "chart", sel: ".venue-pick", title: "Exchange", body: "Exchanges that list the coin. Switching changes the chart, the book and the trading key." },
        { tab: "chart", sel: ".tf-bar", title: "Timeframe", body: "1m, 5m, 15m, 1h, 4h, 1d. Mouse wheel zooms, drag pans in time." },
        { tab: "chart", sel: ".ind-wrap", title: "Indicators", body: "Up to four EMAs with your periods, SMA, VWAP (resets 00:00 UTC), Bollinger 20, 2, volume, RSI 14 and MACD 12, 26, 9 — as panes under the candles. “Reset” restores defaults. The choice is remembered." },
        { tab: "chart", sel: ".scalp-main", title: "Chart", body: "The legend on top: candle OHLC and indicator values. On the chart — the entry line with PnL after fees, your limit orders and dashed TP and SL." },
        { tab: "chart", sel: ".ticket", title: "Ticket", body: "Key (demo or LIVE), 🔔 — sound on fills. Amount in USDT and quick sizes. “Buy/Sell market” — with the best price on the button. “Buy at bid / Sell at ask” — post-only limit: lower fee, the exchange cancels it if it would take liquidity." },
        { tab: "chart", sel: ".one-click", title: "One-click", body: "Orders without confirmation dialogs, keys B — buy, S — sell, X — close, H — close half (any layout). Turns off when you close the tab. Careful on a LIVE key." },
        { tab: "chart", sel: ".pos-card", title: "Position", body: "Side, size, entry, PnL after fees (hover for the breakdown; on demo — by the demo mark price). Liquidation and leverage. Close 25/50/75% or all at market; “Close at best limit” — reduce-only maker. TP and SL are exchange orders: price and “Set”, × removes." },
        { tab: "chart", sel: ".ladder-mini", title: "Ladder", body: "Click — limit at that price for the ticket amount (below market buys, above sells). Click yours — cancel, drag — move, Shift+click — position TP or SL. ×5, ×10, ×50 group ticks on coins with a tiny step." },
      ],
    },
    {
      id: "alerts", title: "Alerts", steps: [
        { tab: "alerts", sel: ".filters", title: "Alert types", body: "Threshold — spread above the set level. Velocity — the spread widened fast within the window. Funding — rate above the threshold. Watchlist — ★ coins when net exceeds its own threshold, no volume filter." },
        { tab: "alerts", sel: ".alerts", title: "Alert feed", body: "Newest on top. “Browser notifications” pops messages even when the tab is minimized. Thresholds and Telegram are in the Telegram settings top right." },
      ],
    },
    {
      id: "journal", title: "Pair trades", steps: [
        { tab: "journal", sel: ".table-wrap", title: "Pair journal", body: "Every pair opened with ⇄: time, pair (demo or LIVE), legs — exchange, size and price, size, entry and PnL. Statuses: open, imbalance (legs filled differently), closed, not filled, closing." },
        { tab: "journal", sel: ".table-wrap", title: "Actions", body: "“Chase” — fill the lagging leg up to the filled one. “Even out” — close the excess on the filled leg. “Close” — both legs with IOC limits within tolerance. “Mark closed” — closed by hand on the exchange or liquidated: PnL is estimated at the current price. “Remove” — when nothing filled." },
      ],
    },
    {
      id: "diary", title: "Diary", steps: [
        { tab: "diary", sel: ".dactions", title: "Trades", body: "“Add trade” by hand: time, pair, market, side, size, entry and exit, fees, funding, leverage, strategy, tags, note. “Import CSV” — an exchange's trade history or closed PnL export; “CSV template” — a sample. CSV export and “Report / PDF” to print. Pairs from the terminal land here by themselves." },
        { tab: "diary", sel: ".dfilters", title: "Filters", body: "Period: 7 days, 30, 90, year to date, year, all. Strategy, exchange, market, coin — every number and chart below is recomputed." },
        { tab: "diary", sel: ".kpis", title: "Stats", body: "Net PnL and expectancy per trade, win rate, profit factor, max drawdown and streaks, average win and loss, best and worst, fees and funding, average hold, unrealized PnL of open positions." },
        { tab: "diary", sel: ".dcharts", title: "Diary charts", body: "Equity curve, PnL by day (calendar) and month, by strategy, exchange, coin, weekday, market, long and short. Hover a bar for the trade count and win rate." },
        { tab: "diary", sel: ".dtable", title: "Trades table", body: "Every trade in the period: edit or delete. Source — the terminal, CSV or manual entry." },
      ],
    },
    {
      id: "setup", title: "Settings", steps: [
        { tab: "cross", sel: "[data-tour=keys]", title: "API keys", body: "Exchange, key, secret and API passphrase (OKX, Bitget, KuCoin, BloFin), demo or live. Keys stay on your computer only, encrypted with your encryption secret: without it the balance is hidden — “Unlock balance”. Start with demo: works as for real, without money. For live, trading rights are enough — no withdrawals." },
        { tab: "cross", sel: "[data-tour=telegram]", title: "Telegram and thresholds", body: "Create a bot with @BotFather, send it /start, enter the token and chat id, “Test”. Alert thresholds live here too: spread %, widen % within a window, cooldown, min volume, funding %, messages per minute. And the math: max quote age, slippage reserve, size for the book spread, net threshold for ★." },
        { tab: "cross", sel: ".chip.status", title: "Link", body: "live — quotes flowing, their age in seconds next to it; off — the link is down, orders will not go out." },
        { tab: "cross", sel: ".upd", title: "Version and updates", body: "ArbDesk and bytx versions. Click for auto-update: “On”, “Notify” or “Off”, and “Check & update now”. Next to it — “Set password” (sign in from other devices) or “Log out”." },
        { tab: "cross", sel: ".lang", title: "Language", body: "EN or RU — the whole interface, this tour included." },
        { sel: "[data-tour=help]", title: "Help", body: "“?” — this tour in full or by chapter and the hotkey list. Almost every button and field has a tip: hover it. Happy trading!" },
      ],
    },
  ],
};
