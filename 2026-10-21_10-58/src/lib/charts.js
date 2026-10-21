// Server-drawn SVG charts (D29). No JavaScript and no inline style, so they pass the CSP; colours come from CSS
// classes in public/css/page-finance.css (both themes). Each chart is role="img" with an aria-label summary, every
// bar carries a <title> (native hover text), and the caller also renders the numbers as a visually hidden table.
// Labels are escaped here; values are numbers only.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A "nice" top for the axis: 1, 2 or 5 times a power of ten at or above max.
export function niceMax(max) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= max);
}

// Vertical bars, oldest on the right (RTL reading order). data: [{ label, value, title }], tick: label every n bars.
// fmt: value -> short text for the axis.
export function barChart(data, { width = 460, height = 210, fmt = String, tick = 1, label = '' } = {}) {
  const padTop = 12;
  const padBottom = 28;
  const padSide = 44; // axis labels on the start (right) side
  const plotW = width - padSide - 8;
  const plotH = height - padTop - padBottom;
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const step = plotW / Math.max(data.length, 1);
  const barW = Math.max(2, Math.min(36, step * 0.66));
  const y = (v) => padTop + plotH - (Math.max(v, 0) / top) * plotH;
  const parts = [];
  for (const f of [0, 0.5, 1]) {
    const gy = y(top * f).toFixed(1);
    parts.push(`<line class="ch-grid" x1="0" x2="${(plotW + 8).toFixed(1)}" y1="${gy}" y2="${gy}"/>`);
    parts.push(`<text class="ch-axis" x="${(width - 4).toFixed(1)}" y="${(Number(gy) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(top * f))}</text>`);
  }
  data.forEach((d, i) => {
    // Right to left: the first item sits next to the axis on the right.
    const cx = plotW - (i + 0.5) * step;
    const by = y(d.value);
    const h = Math.max(padTop + plotH - by, d.value > 0 ? 1.5 : 0);
    parts.push(`<rect class="ch-bar${d.highlight ? ' ch-bar-hi' : ''}" x="${(cx - barW / 2).toFixed(1)}" y="${(padTop + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${esc(d.title ?? `${d.label}: ${fmt(d.value)}`)}</title></rect>`);
    if (i % tick === 0) parts.push(`<text class="ch-label" x="${cx.toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle">${esc(d.label)}</text>`);
  });
  return `<svg class="chart" direction="ltr" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

// Horizontal bars for shares (revenue by source). data: [{ label, value }], biggest first.
export function hbarChart(data, { width = 460, row = 28, fmt = String, label = '' } = {}) {
  const labelW = 120;
  const valueW = 104;
  const barMax = width - labelW - valueW - 16;
  const max = Math.max(1, ...data.map((d) => d.value));
  const height = Math.max(row, data.length * row) + 4;
  const parts = data.map((d, i) => {
    const yy = i * row + 4;
    const w = Math.max((d.value / max) * barMax, d.value > 0 ? 2 : 0);
    // RTL: label on the right, bar grows leftwards from it, value at the far left.
    const barStart = width - labelW - 8;
    return `<text class="ch-label" x="${width}" y="${(yy + row / 2 + 1).toFixed(1)}" text-anchor="end">${esc(d.label)}</text>`
      + `<rect class="ch-bar${i === 0 ? ' ch-bar-hi' : ''}" x="${(barStart - w).toFixed(1)}" y="${(yy + 5).toFixed(1)}" width="${w.toFixed(1)}" height="${(row - 12).toFixed(1)}" rx="4"><title>${esc(`${d.label}: ${fmt(d.value)}`)}</title></rect>`
      + `<text class="ch-value" x="0" y="${(yy + row / 2 + 1).toFixed(1)}" text-anchor="start">${esc(fmt(d.value))}</text>`;
  });
  return `<svg class="chart" direction="ltr" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}
