'use client';

import { useId } from 'react';

export type ChartSeries = {
  name: string;
  color: string;
  values: number[];
  fill?: boolean;
};

type Props = {
  labels: string[];
  series: ChartSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  formatLabel?: (label: string) => string;
};

const PADDING = { top: 16, right: 16, bottom: 32, left: 58 };
const WIDTH = 820;

export function TimeSeriesChart({
  labels,
  series,
  height = 220,
  formatValue = (value) => String(value),
  formatLabel = (label) => label,
}: Props) {
  const gradientPrefix = useId().replace(/:/g, '');
  const chartHeight = height;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = chartHeight - PADDING.top - PADDING.bottom;
  const maxValue = Math.max(1, ...series.flatMap((item) => item.values));
  const pointCount = Math.max(labels.length, 1);

  const x = (index: number) => PADDING.left + (pointCount === 1 ? innerWidth / 2 : (index / (pointCount - 1)) * innerWidth);
  const y = (value: number) => PADDING.top + innerHeight - (Math.max(0, value) / maxValue) * innerHeight;
  const labelStep = Math.max(1, Math.ceil(labels.length / 6));

  function path(values: number[]) {
    return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(' ');
  }

  function area(values: number[]) {
    if (values.length === 0) return '';
    const base = PADDING.top + innerHeight;
    return `${path(values)} L ${x(values.length - 1).toFixed(2)} ${base.toFixed(2)} L ${x(0).toFixed(2)} ${base.toFixed(2)} Z`;
  }

  if (labels.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center text-sm text-zinc-500">
        No data for this period.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        {series.map((item) => (
          <span key={item.name} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${chartHeight}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={series.map((item) => item.name).join(', ')}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = PADDING.top + innerHeight * ratio;
          const value = maxValue * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={lineY}
                y2={lineY}
                stroke="#27272a"
                strokeDasharray="3 4"
                strokeWidth="1"
              />
              <text x={PADDING.left - 8} y={lineY + 4} textAnchor="end" fontSize="10" fill="#71717a">
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {labels.map((label, index) => {
          if (index % labelStep !== 0 && index !== labels.length - 1) return null;
          return (
            <text
              key={`${label}-${index}`}
              x={x(index)}
              y={chartHeight - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#71717a"
            >
              {formatLabel(label)}
            </text>
          );
        })}

        {series.map((item, seriesIndex) => (
          <g key={item.name}>
            {item.fill && (
              <>
                <defs>
                  <linearGradient id={`${gradientPrefix}-${seriesIndex}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={item.color} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={item.color} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={area(item.values)} fill={`url(#${gradientPrefix}-${seriesIndex})`} />
              </>
            )}
            <path
              d={path(item.values)}
              fill="none"
              stroke={item.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {item.values.map((value, index) => (
              <circle
                key={`${item.name}-${index}`}
                cx={x(index)}
                cy={y(value)}
                r="2.5"
                fill={item.color}
                className="opacity-0 hover:opacity-100"
              >
                <title>{`${item.name} · ${formatLabel(labels[index])}: ${formatValue(value)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
