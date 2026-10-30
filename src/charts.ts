// Server-rendered SVG bar charts: no chart script, colors from CSS classes,
// each day hoverable through a native <title> on a full-height target.

export interface Bar {
  day: string;
  up: number;
  down?: number;
  title: string;
}

const WIDTH = 720;
const LEFT = 44;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 24;
const GAP = 2;
const RADIUS = 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
}

function number(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`;
}

// A bar anchored on the baseline, rounded only at its data end.
function barPath(x: number, width: number, baseline: number, height: number, upward: boolean): string {
  const r = Math.min(RADIUS, width / 2, height);
  const end = upward ? baseline - height : baseline + height;
  const towards = upward ? r : -r;
  const sweep = upward ? 1 : 0;
  return [
    `M${x} ${baseline}`,
    `V${end + towards}`,
    `A${r} ${r} 0 0 ${sweep} ${x + r} ${end}`,
    `H${x + width - r}`,
    `A${r} ${r} 0 0 ${sweep} ${x + width} ${end + towards}`,
    `V${baseline}`,
    "Z",
  ].join(" ");
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function barChart(options: {
  bars: Bar[];
  label: string;
  upClass: string;
  downClass?: string;
  height?: number;
}): string {
  const { bars } = options;
  const mirrored = options.downClass !== undefined;
  const height = options.height ?? (mirrored ? 240 : 180);
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = height - TOP - BOTTOM;
  const maxUp = niceMax(Math.max(0, ...bars.map((bar) => bar.up)));
  const maxDown = mirrored ? niceMax(Math.max(0, ...bars.map((bar) => bar.down ?? 0))) : 0;
  const scale = plotHeight / (maxUp + maxDown);
  const baseline = TOP + maxUp * scale;
  const slot = plotWidth / Math.max(1, bars.length);
  const barWidth = Math.max(1, slot - GAP);
  const labelEvery = bars.length > 45 ? 14 : 7;

  const grid = [
    { value: maxUp, y: TOP },
    { value: maxUp / 2, y: TOP + (maxUp / 2) * scale },
    { value: 0, y: baseline },
    // The lower scale gets a line only when there is room to label it.
    ...(mirrored && maxDown * scale >= 16 ? [{ value: -maxDown, y: baseline + maxDown * scale }] : []),
  ]
    .map(
      (line) =>
        `<line class="chart-grid${line.value === 0 ? " chart-zero" : ""}" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${line.y}" y2="${line.y}" />` +
        `<text class="chart-axis" x="${LEFT - 6}" y="${line.y + 4}" text-anchor="end">${number(Math.abs(line.value))}</text>`,
    )
    .join("");

  const marks = bars
    .map((bar, index) => {
      const x = LEFT + index * slot + GAP / 2;
      const up = bar.up > 0 ? `<path class="${options.upClass}" d="${barPath(x, barWidth, baseline, bar.up * scale, true)}" />` : "";
      const down =
        mirrored && (bar.down ?? 0) > 0
          ? `<path class="${options.downClass}" d="${barPath(x, barWidth, baseline, (bar.down ?? 0) * scale, false)}" />`
          : "";
      const tick =
        (bars.length - 1 - index) % labelEvery === 0
          ? `<text class="chart-axis" x="${x + barWidth / 2}" y="${height - 6}" text-anchor="middle">${dayLabel(bar.day)}</text>`
          : "";
      return `<g>${up}${down}<rect class="chart-hit" x="${LEFT + index * slot}" y="${TOP}" width="${slot}" height="${plotHeight}"><title>${escape(bar.title)}</title></rect>${tick}</g>`;
    })
    .join("");

  return `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escape(options.label)}">${grid}${marks}</svg></div>`;
}
