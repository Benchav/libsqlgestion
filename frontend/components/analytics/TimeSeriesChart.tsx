'use client';

import { useId, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type ChartSeries = {
  name: string;
  color: string;
  values: Array<number | null>;
  fill?: boolean;
  dashed?: boolean;
};

type Props = {
  labels: string[];
  series: ChartSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  formatLabel?: (label: string) => string;
  formatTooltipLabel?: (label: string) => string;
  emptyMessage?: string;
};

const WIDTH = 820;
const PADDING = { top: 18, right: 16, bottom: 34, left: 70 };
const TICK_COUNT = 4;
const TOOLTIP_WIDTH = 210;

function niceStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

function segmentPoints(values: Array<number | null>) {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];

  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ index, value });
  });

  if (current.length > 0) segments.push(current);
  return segments;
}

export function TimeSeriesChart({
  labels,
  series,
  height = 250,
  formatValue = (value) => String(value),
  formatLabel = (label) => label,
  formatTooltipLabel,
  emptyMessage = 'No data for this period.',
}: Props) {
  const gradientPrefix = useId().replace(/:/g, '');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const chartHeight = height;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = chartHeight - PADDING.top - PADDING.bottom;
  const pointCount = labels.length;
  const tooltipLabel = formatTooltipLabel || formatLabel;

  const numericValues = series.flatMap((item) => item.values).filter(
    (value): value is number => value !== null && Number.isFinite(value) && value > 0,
  );
  const rawMax = numericValues.length > 0 ? Math.max(...numericValues) : 0;
  const axisMax = rawMax > 0 ? niceStep(rawMax / TICK_COUNT) * TICK_COUNT : 1;
  const hasData = labels.length > 0 && numericValues.length > 0;
  const singlePoint = pointCount === 1;

  const xAt = (index: number) => PADDING.left + (pointCount <= 1 ? innerWidth / 2 : (index / (pointCount - 1)) * innerWidth);
  const yAt = (value: number) => PADDING.top + innerHeight - (Math.max(0, value) / axisMax) * innerHeight;
  const baseline = PADDING.top + innerHeight;

  const tickIndices = (() => {
    if (pointCount <= 1) return pointCount === 1 ? [0] : [];
    const count = Math.min(6, pointCount);
    const indices = Array.from({ length: count }, (_, index) => Math.round((index * (pointCount - 1)) / (count - 1)));
    return Array.from(new Set(indices));
  })();

  function linePath(points: Array<{ index: number; value: number }>) {
    return points
      .map((point, position) => `${position === 0 ? 'M' : 'L'} ${xAt(point.index).toFixed(2)} ${yAt(point.value).toFixed(2)}`)
      .join(' ');
  }

  function areaPath(points: Array<{ index: number; value: number }>) {
    if (points.length < 2) return '';
    const first = points[0];
    const last = points[points.length - 1];
    return `${linePath(points)} L ${xAt(last.index).toFixed(2)} ${baseline.toFixed(2)} L ${xAt(first.index).toFixed(2)} ${baseline.toFixed(2)} Z`;
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointCount === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const ratio = (svgX - PADDING.left) / innerWidth;
    const index = pointCount === 1 ? 0 : Math.round(ratio * (pointCount - 1));
    setHoverIndex(Math.max(0, Math.min(pointCount - 1, index)));
  }

  if (!hasData) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-zinc-800/70 bg-zinc-900/20 px-4 text-center text-sm text-zinc-500"
        style={{ height: 220 }}
      >
        {labels.length === 0 ? 'No data for this period.' : emptyMessage}
      </div>
    );
  }

  const tooltipHeight = 36 + series.length * 18;
  const activeIndex = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < pointCount ? hoverIndex : null;
  const hoveredX = activeIndex === null ? 0 : xAt(activeIndex);
  const tooltipX = activeIndex === null
    ? 0
    : Math.min(
      WIDTH - PADDING.right - TOOLTIP_WIDTH,
      Math.max(PADDING.left, hoveredX + 14 + TOOLTIP_WIDTH > WIDTH - PADDING.right
        ? hoveredX - TOOLTIP_WIDTH - 14
        : hoveredX + 14),
    );

  const bars = (() => {
    if (!singlePoint) return [];
    const gap = 10;
    const maxBarWidth = 58;
    const groupWidth = Math.min(innerWidth * 0.55, series.length * maxBarWidth + (series.length - 1) * gap);
    const barWidth = Math.max(10, Math.min(maxBarWidth, (groupWidth - (series.length - 1) * gap) / Math.max(1, series.length)));
    const groupStart = PADDING.left + innerWidth / 2 - (series.length * barWidth + (series.length - 1) * gap) / 2;
    return series.map((item, index) => ({
      item,
      x: groupStart + index * (barWidth + gap),
      width: barWidth,
      value: item.values[0],
    }));
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        {series.map((item) => (
          <span key={item.name} className="inline-flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden="true">
              <line
                x1="1"
                y1="3"
                x2="15"
                y2="3"
                stroke={item.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={item.dashed ? '4 2' : undefined}
              />
            </svg>
            {item.name}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${chartHeight}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={series.map((item) => item.name).join(', ')}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
        onPointerDown={handlePointerMove}
        style={{ touchAction: 'pan-y' }}
      >
        {Array.from({ length: TICK_COUNT + 1 }, (_, index) => {
          const value = axisMax * (1 - index / TICK_COUNT);
          const lineY = PADDING.top + (innerHeight * index) / TICK_COUNT;
          return (
            <g key={index}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={lineY}
                y2={lineY}
                stroke={index === TICK_COUNT ? '#3f3f46' : '#27272a'}
                strokeDasharray={index === TICK_COUNT ? undefined : '3 4'}
                strokeWidth="1"
              />
              <text x={PADDING.left - 10} y={lineY + 4} textAnchor="end" fontSize="10.5" fill="#71717a">
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {tickIndices.map((index) => (
          <text
            key={`${labels[index]}-${index}`}
            x={xAt(index)}
            y={chartHeight - 10}
            textAnchor={index === 0 ? 'start' : index === pointCount - 1 ? 'end' : 'middle'}
            fontSize="10.5"
            fill="#71717a"
          >
            {formatLabel(labels[index])}
          </text>
        ))}

        {singlePoint ? (
          <>
            {bars.map(({ item, x, width, value }) => {
              if (value === null || !Number.isFinite(value) || value <= 0) return null;
              const barY = yAt(value);
              const barHeight = Math.max(1, baseline - barY);
              return (
                <g key={item.name}>
                  <rect
                    x={x}
                    y={barY}
                    width={width}
                    height={barHeight}
                    rx="3"
                    fill={item.color}
                    fillOpacity="0.85"
                    stroke={item.color}
                    strokeOpacity="0.9"
                  >
                    <title>{`${item.name} · ${tooltipLabel(labels[0])}: ${formatValue(value)}`}</title>
                  </rect>
                  <text x={x + width / 2} y={Math.max(12, barY - 7)} textAnchor="middle" fontSize="10" fill={item.color}>
                    {formatValue(value)}
                  </text>
                </g>
              );
            })}
          </>
        ) : (
          <>
            {series.map((item, seriesIndex) => {
              const segments = segmentPoints(item.values);
              return (
                <g key={item.name}>
                  {item.fill && (
                    <defs>
                      <linearGradient id={`${gradientPrefix}-${seriesIndex}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={item.color} stopOpacity="0.28" />
                        <stop offset="100%" stopColor={item.color} stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  )}

                  {item.fill && segments.map((segment, segmentIndex) => (
                    <path
                      key={`area-${segmentIndex}`}
                      d={areaPath(segment)}
                      fill={`url(#${gradientPrefix}-${seriesIndex})`}
                    />
                  ))}

                  {segments.map((segment, segmentIndex) => (
                    segment.length > 1 ? (
                      <path
                        key={`line-${segmentIndex}`}
                        d={linePath(segment)}
                        fill="none"
                        stroke={item.color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={item.dashed ? '5 3' : undefined}
                      />
                    ) : (
                      <g key={`point-${segmentIndex}`}>
                        <circle
                          cx={xAt(segment[0].index)}
                          cy={yAt(segment[0].value)}
                          r="7"
                          fill={item.color}
                          opacity="0.18"
                        />
                        <circle
                          cx={xAt(segment[0].index)}
                          cy={yAt(segment[0].value)}
                          r="3.5"
                          fill={item.color}
                        />
                      </g>
                    )
                  ))}

                  {pointCount <= 40 && segments.flatMap((segment) => segment.map((point) => (
                    <circle
                      key={`dot-${point.index}`}
                      cx={xAt(point.index)}
                      cy={yAt(point.value)}
                      r="2.5"
                      fill={item.color}
                    />
                  )))}
                </g>
              );
            })}
          </>
        )}

        {activeIndex !== null && (
          <g pointerEvents="none">
            <line
              x1={hoveredX}
              x2={hoveredX}
              y1={PADDING.top}
              y2={baseline}
              stroke="#52525b"
              strokeDasharray="3 3"
            />
            {series.map((item) => {
              const value = item.values[activeIndex];
              if (value === null || !Number.isFinite(value)) return null;
              return (
                <circle
                  key={`hover-${item.name}`}
                  cx={xAt(activeIndex)}
                  cy={yAt(value)}
                  r="4"
                  fill={item.color}
                  stroke="#0f0f0f"
                  strokeWidth="2"
                />
              );
            })}
            <g transform={`translate(${tooltipX}, ${PADDING.top + 6})`}>
              <rect
                width={TOOLTIP_WIDTH}
                height={tooltipHeight}
                rx="7"
                fill="#18181b"
                stroke="#3f3f46"
              />
              <text x="12" y="20" fontSize="10.5" fill="#a1a1aa">
                {tooltipLabel(labels[activeIndex])}
              </text>
              {series.map((item, index) => {
                const value = item.values[activeIndex];
                return (
                  <g key={`tooltip-${item.name}`} transform={`translate(12, ${37 + index * 18})`}>
                    <line
                      x1="0"
                      y1="-3"
                      x2="12"
                      y2="-3"
                      stroke={item.color}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray={item.dashed ? '4 2' : undefined}
                    />
                    <text x="18" y="0" fontSize="10.5" fill="#d4d4d8">{item.name}</text>
                    <text x={TOOLTIP_WIDTH - 24} y="0" textAnchor="end" fontSize="10.5" fill="#f4f4f5">
                      {value === null || !Number.isFinite(value) ? '—' : formatValue(value)}
                    </text>
                  </g>
                );
              })}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
