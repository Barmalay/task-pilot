import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { DeployMark, TimeRange } from '@task-pilot/step-kit';
import { formatCount, formatPoint, formatTick, formatValue, seriesColor, timeTicks, valueTicks } from '../monitor.ts';
import { cx } from '../ui.tsx';

/** Ширина элемента в пикселях: графики рисуются по ней, чтобы линии и подписи оставались четкими. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Путь линии с разрывами там, где значения нет. */
function linePath(points: { x: number; y: number | null }[]): string {
  let d = '';
  let open = false;
  for (const p of points) {
    if (p.y === null) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    open = true;
  }
  return d;
}

/** Мини-график обзора: линия серии и точка на последнем значении, без осей. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const w = 120;
  const h = 32;
  const pad = 5;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <div className="h-8 w-[120px]" aria-hidden />;
  const max = Math.max(...nums) || 1;
  const points = values.map((v, i) => ({ x: pad + (i * (w - 2 * pad)) / (values.length - 1), y: v === null ? null : h - pad - (v / max) * (h - 2 * pad) }));
  const last = [...points].reverse().find((p) => p.y !== null)!;
  const whole = points.every((p) => p.y !== null);
  const line = linePath(points);
  return (
    <svg width={w} height={h} role="img" aria-label={label} className="shrink-0 overflow-visible">
      {whole && <path d={`${line}L${points.at(-1)!.x},${h - pad}L${points[0]!.x},${h - pad}Z`} fill="var(--viz-series-1)" opacity={0.1} />}
      <path d={line} fill="none" stroke="var(--viz-series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y!} r={4} fill="var(--viz-series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
    </svg>
  );
}

/** Серия графика по времени. */
export interface ChartSeries {
  label: string;
  points: { t: number; v: number | null }[];
  /** Итог серии за период для легенды. */
  total?: string;
}

/** Легенда: короткий отрезок цвета серии и подпись текстом, как на самом графике; цвета по умолчанию - серий по порядку. */
export function Legend({ series, colors }: { series: ChartSeries[]; colors?: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
      {series.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <svg width={14} height={4} aria-hidden>
            <line x1={1} y1={2} x2={13} y2={2} stroke={colors?.[i] ?? seriesColor(i)} strokeWidth={colors ? 4 : 2} strokeLinecap="round" />
          </svg>
          <span>{s.label}</span>
          {s.total && <span className="tabular-nums text-slate-500">{s.total}</span>}
        </li>
      ))}
    </ul>
  );
}

const MARGIN = { top: 20, right: 12, bottom: 24, left: 52 };

/**
 * График по времени: линии серий (у одной серии с легкой заливкой), тонкая сетка, отметки деплоев и перекрестие с
 * подсказкой. Перекрестие ищет ближайшую точку по X, с клавиатуры его двигают стрелки; подсказка показывает все серии.
 */
export function TimeChart({
  series,
  range,
  bucketMs,
  kind,
  deploys = [],
  height = 200,
  title,
}: {
  series: ChartSeries[];
  range: TimeRange;
  bucketMs: number;
  kind: 'count' | 'ratio';
  deploys?: DeployMark[];
  height?: number;
  title: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const times = series[0]?.points.map((p) => p.t) ?? [];
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const max = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v ?? 0)));
  const yTicks = valueTicks(max, kind);
  const top = yTicks.at(-1)! || 1;
  const span = range.to - range.from || 1;
  const xAt = (t: number) => MARGIN.left + ((t - range.from) / span) * plotW;
  const xOf = (t: number) => xAt(Math.min(range.to, t + bucketMs / 2));
  const yOf = (v: number) => MARGIN.top + plotH - (Math.min(v, top) / top) * plotH;
  const { ticks, step } = timeTicks(range.from, range.to, plotW);
  const periodMs = range.to - range.from;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!times.length) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(xOf(times[i]!) - px) < Math.abs(xOf(times[best]!) - px)) best = i;
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!times.length) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(times.length - 1, (a ?? times.length - 1) + moves[e.key]!)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : times.length - 1);
    } else if (e.key === 'Escape') setActive(null);
  };

  const at = active === null ? null : times[active];
  const tooltipLeft = at === undefined || at === null ? 0 : Math.min(Math.max(xOf(at) + 12, MARGIN.left), Math.max(MARGIN.left, width - 200));
  return (
    <div className="space-y-2">
      {series.length > 1 && <Legend series={series} />}
      <div
        ref={ref}
        className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        tabIndex={0}
        role="group"
        aria-label={`${title}: график, стрелки влево и вправо показывают значения по времени`}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? (times.length ? times.length - 1 : null))}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} className="block touch-none select-none" onPointerMove={pick} onPointerLeave={() => setActive(null)} aria-hidden>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={yOf(v)} y2={yOf(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={MARGIN.left - 8} y={yOf(v)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                  {formatValue(v, kind)}
                </text>
              </g>
            ))}
            {ticks.map((t) => (
              <text key={t} x={xAt(t)} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[11px] tabular-nums">
                {formatTick(t, step)}
              </text>
            ))}
            {deploys
              .filter((d) => d.at >= range.from && d.at < range.to)
              .map((d) => (
                <g key={`${d.service}${d.at}`}>
                  <title>{`Деплой ${d.version}, ${formatPoint(d.at, periodMs)}`}</title>
                  <line x1={xAt(d.at)} x2={xAt(d.at)} y1={MARGIN.top - 4} y2={MARGIN.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={xAt(d.at) + 4} y={MARGIN.top - 8} className="fill-slate-500 text-[10px]">
                    {d.version.replace(/-master$/, '')}
                  </text>
                </g>
              ))}
            {series.map((s, i) => {
              const pts = s.points.map((p) => ({ x: xOf(p.t), y: p.v === null ? null : yOf(p.v) }));
              const line = linePath(pts);
              const whole = series.length === 1 && pts.length > 1 && pts.every((p) => p.y !== null);
              return (
                <g key={s.label}>
                  {whole && <path d={`${line}L${pts.at(-1)!.x},${yOf(0)}L${pts[0]!.x},${yOf(0)}Z`} fill={seriesColor(i)} opacity={0.1} />}
                  <path d={line} fill="none" stroke={seriesColor(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
            {at !== null && at !== undefined && (
              <g>
                <line x1={xOf(at)} x2={xOf(at)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} shapeRendering="crispEdges" />
                {series.map((s, i) => {
                  const v = s.points[active!]?.v;
                  return v === null || v === undefined ? null : <circle key={s.label} cx={xOf(at)} cy={yOf(v)} r={4} fill={seriesColor(i)} stroke="var(--viz-surface)" strokeWidth={2} />;
                })}
              </g>
            )}
          </svg>
        )}
        {at !== null && at !== undefined && (
          <div
            className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
            style={{ left: tooltipLeft, top: MARGIN.top }}
            aria-live="polite"
          >
            <div className="mb-1 text-slate-500 tabular-nums">{formatPoint(at, periodMs)}</div>
            {series.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <svg width={12} height={4} aria-hidden>
                  <line x1={1} y1={2} x2={11} y2={2} stroke={seriesColor(i)} strokeWidth={2} strokeLinecap="round" />
                </svg>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{formatValue(s.points[active!]?.v ?? null, kind)}</span>
                <span className="truncate text-slate-500">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Столбец со скругленным верхом и прямым низом у оси. */
function columnPath(x: number, y: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, base - y);
  if (r <= 0) return '';
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/**
 * Столбцы корзин с подсказкой на каждом, с клавиатуры - стрелками: распределение числа из текста строки или итоги по
 * дням. format подписывает значения (по умолчанию - счетчик), label - корзины, detail - вторую строку подсказки
 * (по умолчанию границы корзины).
 */
export function Columns({
  buckets,
  interval,
  title,
  height = 180,
  format = formatCount,
  label = String,
  detail,
}: {
  buckets: { x: number; n: number }[];
  interval: number;
  title: string;
  height?: number;
  format?: (n: number) => string;
  label?: (x: number) => string;
  detail?: (bucket: { x: number; n: number }) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const margin = { top: 12, right: 8, bottom: 24, left: 52 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const yTicks = valueTicks(Math.max(0, ...buckets.map((b) => b.n)), 'count');
  const top = yTicks.at(-1)! || 1;
  const slot = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(2, Math.min(24, slot - 2));
  const base = margin.top + plotH;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 44))));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((a) => Math.max(0, Math.min(buckets.length - 1, (a ?? -1) + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  const b = active === null ? null : buckets[active];
  return (
    <div
      ref={ref}
      className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      tabIndex={0}
      role="group"
      aria-label={`${title}: распределение, стрелки показывают корзины`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block select-none" onPointerLeave={() => setActive(null)} aria-hidden>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={margin.left} x2={width - margin.right} y1={base - (v / top) * plotH} y2={base - (v / top) * plotH} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={margin.left - 8} y={base - (v / top) * plotH} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                {format(v)}
              </text>
            </g>
          ))}
          {buckets.map((bucket, i) => {
            const x = margin.left + i * slot + (slot - barW) / 2;
            const y = base - (bucket.n / top) * plotH;
            return (
              <g key={bucket.x} onPointerEnter={() => setActive(i)}>
                <rect x={margin.left + i * slot} y={margin.top} width={slot} height={plotH} fill="transparent" />
                <path d={columnPath(x, y, barW, base)} fill="var(--viz-series-1)" opacity={active === null || active === i ? 1 : 0.55} />
                {i % labelEvery === 0 && (
                  <text x={margin.left + i * slot + slot / 2} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[11px] tabular-nums">
                    {label(bucket.x)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {b && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={{ left: Math.min(margin.left + active! * slot + slot / 2 + 8, Math.max(0, width - 160)), top: margin.top }}
          aria-live="polite"
        >
          <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{format(b.n)}</span>
          <span className="ml-1.5 text-slate-500 tabular-nums">{detail ? detail(b) : `от ${b.x} до ${b.x + interval}`}</span>
        </div>
      )}
    </div>
  );
}

/** Самые частые значения: горизонтальные полосы одного цвета, значение у конца полосы. */
export function BarList({ items, other }: { items: { key: string; n: number }[]; other: number }) {
  const total = items.reduce((a, x) => a + x.n, 0) + other;
  const max = Math.max(1, ...items.map((x) => x.n), other);
  const rows = [...items.map((x) => ({ ...x, muted: false })), ...(other > 0 ? [{ key: 'остальные', n: other, muted: true }] : [])];
  if (!rows.length) return <p className="text-sm text-slate-500">Строк за период нет</p>;
  return (
    <ul className="space-y-2">
      {rows.map((x) => (
        <li key={x.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
          <span className={cx('truncate', x.muted ? 'italic text-slate-500' : 'text-slate-700 dark:text-slate-200')} title={x.key}>
            {x.key}
          </span>
          <span className="tabular-nums text-slate-600 dark:text-slate-300">
            {formatCount(x.n)}
            <span className="ml-1.5 text-xs text-slate-400">{total ? `${Math.round((x.n / total) * 100)}%` : ''}</span>
          </span>
          <div className="col-span-2 h-2.5 rounded-r bg-slate-100 dark:bg-slate-800">
            <div className="h-2.5 rounded-r" style={{ width: `${(x.n / max) * 100}%`, background: x.muted ? 'var(--viz-axis)' : 'var(--viz-series-1)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Табличный вид графика: те же значения без цвета, чтобы их можно было прочитать и сверить. */
export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-800">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-2.5 py-1 text-slate-700 dark:text-slate-200">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Часть столбца с накоплением: ключ значения, подпись в легенде и цвет. */
export interface StackPart {
  key: string;
  label: string;
  color: string;
}

/**
 * Столбцы с накоплением: части parts снизу вверх, узкий столбец side рядом (ветка, которая в основной столбец не
 * входит). Подсказка на каждом столбце, с клавиатуры - стрелками; подписи оси дает label (null - без подписи).
 */
export function StackColumns({
  items,
  parts,
  side,
  title,
  height = 220,
  label,
  tip,
}: {
  items: { key: string; values: Record<string, number> }[];
  parts: StackPart[];
  side?: StackPart;
  title: string;
  height?: number;
  label: (key: string, i: number) => string | null;
  tip: (i: number) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const margin = { top: 12, right: 8, bottom: 24, left: 52 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const totals = items.map((it) => parts.reduce((a, p) => a + (it.values[p.key] ?? 0), 0));
  const sides = items.map((it) => (side ? (it.values[side.key] ?? 0) : 0));
  const yTicks = valueTicks(Math.max(0, ...totals, ...sides), 'count');
  const top = yTicks.at(-1)! || 1;
  const slot = items.length ? plotW / items.length : 0;
  const barW = Math.max(1.5, Math.min(26, slot * 0.7));
  const mainW = side ? barW * 0.7 : barW;
  const base = margin.top + plotH;
  const h = (n: number) => (n / top) * plotH;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((a) => Math.max(0, Math.min(items.length - 1, (a ?? items.length) + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  return (
    <div className="space-y-2">
      <Legend series={[...parts, ...(side ? [side] : [])].map((p) => ({ label: p.label, points: [] }))} colors={[...parts, ...(side ? [side] : [])].map((p) => p.color)} />
      <div
        ref={ref}
        className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        tabIndex={0}
        role="group"
        aria-label={`${title}: столбцы, стрелки показывают значения`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} className="block select-none" onPointerLeave={() => setActive(null)} aria-hidden>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={margin.left} x2={width - margin.right} y1={base - h(v)} y2={base - h(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={margin.left - 8} y={base - h(v)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                  {formatCount(v)}
                </text>
              </g>
            ))}
            {items.map((it, i) => {
              const x = margin.left + i * slot + (slot - barW) / 2;
              let y = base;
              const text = label(it.key, i);
              return (
                <g key={it.key} onPointerEnter={() => setActive(i)} opacity={active === null || active === i ? 1 : 0.6}>
                  <rect x={margin.left + i * slot} y={margin.top} width={slot} height={plotH} fill="transparent" />
                  {parts.map((p) => {
                    const ph = h(it.values[p.key] ?? 0);
                    if (ph <= 0) return null;
                    y -= ph;
                    return <rect key={p.key} x={x} y={y} width={mainW} height={Math.max(1, ph - 1)} fill={p.color} rx={1.5} />;
                  })}
                  {side && sides[i]! > 0 && <rect x={x + mainW + 1} y={base - h(sides[i]!)} width={Math.max(1, barW - mainW - 1)} height={h(sides[i]!)} fill={side.color} />}
                  {text && (
                    <text x={margin.left + i * slot + slot / 2} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[11px] tabular-nums">
                      {text}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {active !== null && items[active] && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
            style={{ left: Math.min(margin.left + active * slot + slot / 2 + 8, Math.max(0, width - 200)), top: margin.top }}
            aria-live="polite"
          >
            {tip(active)}
          </div>
        )}
      </div>
    </div>
  );
}
