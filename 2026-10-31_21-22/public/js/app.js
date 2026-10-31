// Small progressive enhancements. Every page works without this file; it only adds:
//  - a show/hide button on password fields
//  - a Jalali (Persian calendar) date picker on inputs marked data-jalali
//  - advanced search rows that adapt to their field, and the status switch button (enhanceRule, enhanceStatus)
//  - instant submit for file inputs marked data-autosubmit (the profile photo)
//  - drop-zone feedback and shrinking of photos over 3 MB before upload (D21)
import * as jc from './jalali-math.js';

document.documentElement.classList.add('js');

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) node.append(c);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

// ---------- password show/hide ----------

function enhancePassword(input) {
  const wrap = el('span', { class: 'field-addon' });
  input.replaceWith(wrap);
  const button = el('button', { type: 'button', class: 'addon-btn', 'aria-label': 'نمایش رمز عبور', 'aria-pressed': 'false', title: 'نمایش رمز عبور' }, [icon('i-eye')]);
  wrap.append(input, button);
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const label = show ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', label);
    button.title = label;
    input.focus();
  });
  // Switch back before submitting so the browser's password manager still sees a password field.
  input.form?.addEventListener('submit', () => { input.type = 'password'; });
}

// ---------- Jalali date picker ----------

let openPicker = null;

function closePicker(focusButton = false) {
  if (!openPicker) return;
  const { pop, button } = openPicker;
  pop.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  if (focusButton) button.focus();
  openPicker = null;
}

function enhanceDate(input) {
  const wrap = el('span', { class: 'field-addon jdp' });
  input.replaceWith(wrap);
  const button = el('button', {
    type: 'button', class: 'addon-btn', 'aria-label': 'انتخاب تاریخ از تقویم', title: 'انتخاب تاریخ از تقویم',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  }, [icon('i-calendar')]);
  // tabindex -1: a click on the popup's background keeps focus inside, so the focusout check below leaves it open.
  const pop = el('div', { class: 'jdp-pop', role: 'dialog', 'aria-label': 'تقویم شمسی', hidden: true, tabindex: '-1' });
  wrap.append(input, button, pop);

  const now = jc.today();
  const years = [];
  for (let y = now.jy + 5; y >= 1300; y--) years.push(y);
  const prev = el('button', { type: 'button', class: 'jdp-nav', 'aria-label': 'ماه قبل', text: '›' });
  const next = el('button', { type: 'button', class: 'jdp-nav', 'aria-label': 'ماه بعد', text: '‹' });
  const month = el('select', { class: 'jdp-select', 'aria-label': 'ماه' }, MONTHS.map((m, i) => el('option', { value: i + 1, text: m })));
  const year = el('select', { class: 'jdp-select', 'aria-label': 'سال' }, years.map((y) => el('option', { value: y, text: fa(y) })));
  const grid = el('div', { class: 'jdp-grid', role: 'group', 'aria-label': 'روزهای ماه' });
  const todayBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'امروز' });
  const clearBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'پاک کردن' });
  pop.append(
    el('div', { class: 'jdp-head' }, [prev, month, year, next]),
    el('div', { class: 'jdp-week', 'aria-hidden': 'true' }, WEEKDAYS.map((d) => el('span', { text: d }))),
    grid,
    el('div', { class: 'jdp-foot' }, [todayBtn, clearBtn]),
  );

  let view = { jy: now.jy, jm: now.jm };

  function pick(d) {
    input.value = jc.format(d);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closePicker(true);
  }

  function render(focusDay) {
    month.value = String(view.jm);
    if (![...year.options].some((o) => o.value === String(view.jy))) year.prepend(el('option', { value: view.jy, text: fa(view.jy) }));
    year.value = String(view.jy);
    grid.replaceChildren();
    const selected = jc.parse(input.value);
    const lead = jc.weekColumn(view.jy, view.jm, 1);
    for (let i = 0; i < lead; i++) grid.append(el('span'));
    const days = jc.monthLength(view.jy, view.jm);
    for (let d = 1; d <= days; d++) {
      const date = { jy: view.jy, jm: view.jm, jd: d };
      const isSel = selected && selected.jy === date.jy && selected.jm === date.jm && selected.jd === d;
      const isToday = now.jy === date.jy && now.jm === date.jm && now.jd === d;
      const b = el('button', {
        type: 'button', class: `jdp-day${isSel ? ' is-selected' : ''}${isToday ? ' is-today' : ''}`,
        'data-day': d, 'aria-label': `${fa(d)} ${MONTHS[view.jm - 1]} ${fa(view.jy)}`, 'aria-current': isToday ? 'date' : false,
        'aria-pressed': isSel ? 'true' : 'false', tabindex: '-1', text: fa(d),
      });
      b.addEventListener('click', () => pick(date));
      grid.append(b);
    }
    const target = grid.querySelector(`[data-day="${Math.min(focusDay ?? (isSelInView(selected) ? selected.jd : 1), days)}"]`);
    target.tabIndex = 0;
    if (focusDay) target.focus();
  }
  const isSelInView = (s) => s && s.jy === view.jy && s.jm === view.jm;

  function shift(months) {
    const index = view.jy * 12 + (view.jm - 1) + months;
    view = { jy: Math.floor(index / 12), jm: (index % 12) + 1 };
  }

  prev.addEventListener('click', () => { shift(-1); render(); });
  next.addEventListener('click', () => { shift(1); render(); });
  month.addEventListener('change', () => { view.jm = Number(month.value); render(); });
  year.addEventListener('change', () => { view.jy = Number(year.value); render(); });
  todayBtn.addEventListener('click', () => pick(now));
  clearBtn.addEventListener('click', () => { input.value = ''; closePicker(true); });

  // Arrow keys move by day and week (RTL: left is the next day), Enter picks, Escape closes.
  grid.addEventListener('keydown', (e) => {
    const day = Number(e.target.dataset?.day);
    if (!day) return;
    const step = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 }[e.key];
    if (!step) return;
    e.preventDefault();
    let target = day + step;
    const len = jc.monthLength(view.jy, view.jm);
    if (target < 1) { shift(-1); target += jc.monthLength(view.jy, view.jm); } else if (target > len) { target -= len; shift(1); }
    render(target);
  });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePicker(true); } });
  // Tabbing out of the field and its calendar closes the calendar. Checked after the event, because
  // render() replaces the focused day button (arrow keys), which fires focusout with no target.
  wrap.addEventListener('focusout', () => {
    setTimeout(() => {
      if (openPicker?.pop === pop && !wrap.contains(document.activeElement)) closePicker();
    }, 0);
  });

  button.addEventListener('click', () => {
    if (openPicker?.pop === pop) return closePicker();
    closePicker();
    const selected = jc.parse(input.value);
    view = selected ? { jy: selected.jy, jm: selected.jm } : { jy: now.jy, jm: now.jm };
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openPicker = { pop, button };
    render(selected ? selected.jd : now.jd);
  });

  // Search rows: the picker is only offered when the row's field is a date field.
  const controller = input.dataset.jalali && input.form?.elements.namedItem(input.dataset.jalali);
  if (controller) {
    const sync = () => {
      const on = controller.selectedOptions[0]?.dataset.type === 'date';
      wrap.classList.toggle('jdp-off', !on);
      if (!on && openPicker?.pop === pop) closePicker();
    };
    controller.addEventListener('change', sync);
    sync();
  }
}

document.addEventListener('click', (e) => {
  if (openPicker && !openPicker.pop.parentElement.contains(e.target)) closePicker();
});

// ---------- advanced search rows ----------
// Each row adapts to its field: the operator list shows only operators that fit, "between" shows a second value,
// and list fields (sex, blood type) show buttons. The text boxes stay the source of truth, so the form still
// submits the same names without this script.

function enhanceRule(row) {
  const form = row.closest('form');
  const n = row.querySelector('select[name^="f"]').name.slice(1);
  const field = form.elements.namedItem(`f${n}`);
  const op = form.elements.namedItem(`o${n}`);
  const v = form.elements.namedItem(`v${n}`);
  const w = form.elements.namedItem(`w${n}`);
  const vBox = v.closest('.jdp') ?? v;
  const wBox = w.closest('.jdp') ?? w;
  const labels = JSON.parse(op.dataset.labels);
  const group = el('div', { class: 'qb-choices', role: 'group', 'aria-label': 'مقدار', hidden: true });
  vBox.after(group);

  const showChoices = (choices) => {
    group.replaceChildren(...choices.map(([value, label]) => {
      const b = el('button', { type: 'button', class: 'qb-choice', 'data-value': value, text: label, 'aria-pressed': String(v.value === value) });
      b.addEventListener('click', () => {
        v.value = v.value === value ? '' : value; // pressing the chosen button again clears it
        group.querySelectorAll('.qb-choice').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.value === v.value)));
      });
      return b;
    }));
  };

  const sync = (fieldChanged) => {
    const opt = field.selectedOptions[0];
    if (fieldChanged) {
      // A chosen field offers only its own operators, first one preselected; no field offers them all.
      const ops = opt?.dataset.ops ? opt.dataset.ops.split(' ') : Object.keys(labels);
      const keep = ops.includes(op.value) ? op.value : opt?.dataset.ops ? ops[0] : '';
      op.replaceChildren(...(opt?.dataset.ops ? [] : [el('option', { value: '', text: 'عملگر' })]), ...ops.map((k) => el('option', { value: k, text: labels[k] })));
      op.value = keep;
    }
    const choices = opt?.dataset.choices ? JSON.parse(opt.dataset.choices) : null;
    if (fieldChanged && choices && !choices.some(([c]) => c === v.value)) v.value = '';
    vBox.hidden = Boolean(choices);
    group.hidden = !choices;
    if (choices) showChoices(choices);
    const between = op.value === 'between';
    wBox.hidden = !between;
    if (!between) w.value = '';
    const isDate = opt?.dataset.type === 'date';
    v.placeholder = between ? 'از' : isDate ? '۱۴۰۳/۰۵/۱۲' : 'مقدار';
    w.placeholder = 'تا';
  };
  field.addEventListener('change', () => sync(true));
  op.addEventListener('change', () => sync(false));
  sync(false);
}

// The status switch: one button that cycles through the options of its <select> and changes colour with each.
const STATUS_COLOR = { '': 'chip-info', active: 'chip-ok', pending: 'chip-warn', critical: 'chip-crit', archived: 'chip-mute' };

function enhanceStatus(select) {
  const button = el('button', { type: 'button', class: 'chip qb-status-btn' });
  const paint = () => {
    const label = select.selectedOptions[0].textContent;
    button.className = `chip qb-status-btn ${STATUS_COLOR[select.value] ?? 'chip-info'}`;
    button.textContent = label;
    button.setAttribute('aria-label', `وضعیت پرونده: ${label}. برای تغییر بزنید.`);
  };
  button.addEventListener('click', () => {
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    paint();
  });
  select.hidden = true;
  select.after(button);
  paint();
}

// ---------- copy buttons (contact page) ----------

function enhanceCopy(button) {
  const label = button.querySelector('span');
  const idle = label.textContent;
  let timer;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = 'کپی شد';
      button.setAttribute('data-done', '');
    } catch {
      label.textContent = 'کپی نشد';
    }
    clearTimeout(timer);
    timer = setTimeout(() => { label.textContent = idle; button.removeAttribute('data-done'); }, 1800);
  });
}

// ---------- thousands grouping in amount boxes (D39) ----------
// Every .input-money box shows commas while the user types: 1250000 -> 1,250,000. Persian and Arabic digits turn into
// Latin ones at once. Text with anything besides digits and separators (a pasted "50000 R") is left as typed for the
// server, which reads the suffix or refuses it. The cursor keeps its place among the digits, and Backspace or Delete
// next to a comma removes the digit beyond it. The server strips commas, so the box works the same without JS.
const toLatin = (s) => s.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const groupDigits = (digits) => digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function enhanceMoney(input) {
  // Rewrites the box from its digits; `digitsBefore` digits stay left of the cursor.
  const regroup = (digits, digitsBefore) => {
    const text = groupDigits(digits);
    input.value = text;
    let pos = 0;
    for (let seen = 0; pos < text.length && seen < digitsBefore; pos += 1) if (/\d/.test(text[pos])) seen += 1;
    if (document.activeElement === input) input.setSelectionRange(pos, pos);
  };
  const plain = () => /^[\d,٬،\s]*$/.test(toLatin(input.value));
  const format = () => {
    if (!plain()) return;
    const value = toLatin(input.value);
    const caret = input.selectionStart ?? value.length;
    const digitsBefore = value.slice(0, caret).replace(/\D/g, '').length;
    const digits = value.replace(/\D/g, '');
    // Leading zeros removed by groupDigits shift the cursor too.
    const zeros = Math.min(digits.length - groupDigits(digits).replace(/\D/g, '').length, digitsBefore);
    regroup(digits, digitsBefore - zeros);
  };
  input.addEventListener('input', format);
  input.addEventListener('keydown', (e) => {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || input.selectionStart !== input.selectionEnd || !plain()) return;
    const pos = input.selectionStart;
    const value = input.value;
    const comma = e.key === 'Backspace' ? pos - 1 : pos;
    if (value[comma] !== ',') return;
    e.preventDefault();
    const target = e.key === 'Backspace' ? comma - 1 : comma + 1; // the digit beyond the comma
    const digitsBefore = value.slice(0, target).replace(/\D/g, '').length;
    regroup((value.slice(0, target) + value.slice(target + 1)).replace(/\D/g, ''), digitsBefore);
  });
  format();
}

// ---------- SMS wording editor (D32+) ----------
// Draggable buttons for {نام} {تاریخ} {ساعت}: a drop lands natively in the textarea, a click inserts at the cursor. Shows the
// length, the number of SMS parts (Persian text: 70 characters, then 67 per part) and, on the settings page, a sample line.
function enhanceSmsTemplate(area) {
  const wrap = area.closest('.sms-editor');
  const count = wrap.querySelector('[data-sms-count]');
  const sampleEl = wrap.querySelector('[data-sms-sample]');
  const tokens = wrap.querySelector('[data-sms-tokens]');
  const sample = { '{نام}': area.dataset.sampleName, '{تاریخ}': area.dataset.sampleDate, '{ساعت}': area.dataset.sampleTime };
  const parts = (n) => (n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67));
  const update = () => {
    const shown = sampleEl ? area.value.replace(/{(?:نام|تاریخ|ساعت)}/g, (m) => sample[m] ?? m) : area.value;
    const n = Array.from(shown).length;
    count.textContent = `${fa(n)} نویسه · ${fa(parts(n))} پیامک`;
    if (sampleEl) sampleEl.textContent = shown;
  };
  if (tokens) {
    tokens.hidden = false;
    tokens.querySelectorAll('[data-token]').forEach((button) => {
      button.addEventListener('click', () => {
        area.setRangeText(button.dataset.token, area.selectionStart, area.selectionEnd, 'end');
        area.focus();
        update();
      });
      button.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', button.dataset.token);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
  }
  area.addEventListener('input', update);
  update();
}

// ---------- image shrinking before upload (D21) ----------
// JPG/PNG over 3 MB are redrawn on a canvas as JPEG: long edge at most 2560 px, quality stepped down, then the
// size stepped down, until the file fits. The server never decodes images; it still checks type and 30 MB.
// Redrawing also drops EXIF data such as GPS. If anything fails, the original file is uploaded unchanged.

const SHRINK_LIMIT = 3 * 1024 * 1024;
const MULTI_LIMIT = 30 * 1024 * 1024;
const MAX_EDGE = 2560;
const isShrinkable = (f) => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
const mbText = (n) => fa((n / 1048576).toFixed(1)).replace('.', '٫') + ' مگابایت';

async function shrinkImage(file) {
  if (file.size <= SHRINK_LIMIT || !isShrinkable(file)) return file;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  try {
    for (let round = 0; round < 8; round++) {
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      ctx.fillStyle = '#fff'; // PNG transparency becomes white, not black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      for (const q of [0.9, 0.8, 0.7, 0.6]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
        if (blob && blob.size <= SHRINK_LIMIT) {
          const name = file.name.replace(/\.(jpe?g|png)$/i, '') + '.jpg';
          return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
        }
      }
      scale *= 0.8;
    }
  } finally {
    bmp.close();
  }
  return file;
}

// Replaces the input's files with shrunk copies when needed. Resolves to the files that will be uploaded.
async function prepareFiles(input) {
  const files = [...input.files];
  const out = [];
  for (const file of files) {
    try { out.push(await shrinkImage(file)); } catch { out.push(file); }
  }
  if (out.some((file, i) => file !== files[i])) {
    try {
      const dt = new DataTransfer();
      out.forEach((file) => dt.items.add(file));
      input.files = dt.files;
    } catch {
      return files;
    }
  }
  return out;
}

// While a file is being shrunk the form must not submit the original.
const busyForms = new WeakSet();
document.addEventListener('submit', (e) => { if (busyForms.has(e.target)) e.preventDefault(); }, true);

async function withBusy(input, task) {
  busyForms.add(input.form);
  try { return await task(); } finally { busyForms.delete(input.form); }
}

// ---------- drop zone ----------

function enhanceDropzone(input) {
  const zone = input.closest('.dropzone');
  const label = zone.querySelector('[data-dropzone-file]');
  let depth = 0;
  zone.addEventListener('dragenter', () => { depth++; zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-over'); } });
  zone.addEventListener('drop', () => { depth = 0; zone.classList.remove('is-over'); });
  input.addEventListener('change', () => withBusy(input, async () => {
    const files = [...input.files];
    zone.classList.toggle('has-file', files.length > 0);
    if (!files.length) { label.textContent = ''; return; }
    const big = files.some((f) => f.size > SHRINK_LIMIT && isShrinkable(f));
    if (big) {
      zone.classList.add('is-busy');
      label.textContent = files.length === 1 ? `در حال کوچک‌سازی ${files[0].name}…` : 'در حال کوچک‌سازی عکس‌ها…';
    }
    const out = await prepareFiles(input);
    zone.classList.remove('is-busy');
    if (out.length === 1) {
      const [file, done] = [files[0], out[0]];
      label.textContent = done !== file
        ? `${done.name} · از ${mbText(file.size)} به ${mbText(done.size)} کوچک شد`
        : `${done.name} · ${mbText(done.size)}`;
      return;
    }
    // Several files (new-patient form, D49): they travel in one request, which the server caps at 30 MB.
    const total = out.reduce((n, f) => n + f.size, 0);
    label.textContent = `${fa(out.length)} فایل · ${mbText(total)}`
      + (total > MULTI_LIMIT ? ' · بیش از ۳۰ مگابایت است؛ چند فایل را بعداً از صفحه‌ی بیمار بارگذاری کنید' : '');
  }));
}

// ---------- live clock (dashboard) ----------

const jalaliFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
// weekday day month year, e.g. سه‌شنبه ۲۸ مهر ۱۴۰۵ (the plain format() order and punctuation differ by browser)
const jalaliText = (date) => { const p = Object.fromEntries(jalaliFmt.formatToParts(date).map((x) => [x.type, x.value])); return `${p.weekday} ${p.day} ${p.month} ${p.year}`; };
const gregFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function enhanceClock(card) {
  const part = (name) => [...card.querySelectorAll(`[data-part="${name}"] .seg`)];
  const [hours, minutes, seconds] = ['h', 'm', 's'].map(part);
  const jalali = card.querySelector('[data-clock-jalali]');
  const greg = card.querySelector('[data-clock-greg]');
  const sr = card.querySelector('[data-clock-sr]');
  let day = '';
  let minute = '';
  const set = (digits, value) => digits.forEach((seg, i) => { if (seg.dataset.n !== value[i]) seg.dataset.n = value[i]; });
  const tick = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const [h, m, s] = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())];
    set(hours, h); set(minutes, m); set(seconds, s);
    if (h + m !== minute) { minute = h + m; if (sr) sr.textContent = `${h}:${m}`.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]); }
    const today = now.toDateString();
    if (today !== day) { day = today; jalali.textContent = jalaliText(now); greg.textContent = gregFmt.format(now).replace(',', ''); }
  };
  tick();
  setInterval(tick, 1000);
}

document.querySelectorAll('[data-clock]').forEach(enhanceClock);

// ---------- sign-in sun ----------

// The terracotta sun on the sign-in panel leans toward the pointer and turns its lit side to face it; it can be
// grabbed and pulled (with growing resistance) and springs back onto its ring when let go. Decorative only, so
// it is skipped under reduced motion and the still sun stays. Uses the `translate` property, so the CSS rise-in
// animation on `transform` keeps working underneath.
function enhanceSun(sun) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const panel = sun.closest('.auth-side');
  const pos = { x: 0, y: 0 };
  const vel = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let grab = null;
  let frame = 0;
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));
  // Rubber band: the further it is pulled, the less it follows (approaches `max`, never passes it).
  const band = (d, max) => Math.sign(d) * max * (1 - 1 / (Math.abs(d) / max + 1));
  const center = () => {
    const r = sun.getBoundingClientRect();
    return { x: r.left + r.width / 2 - pos.x, y: r.top + r.height / 2 - pos.y };
  };
  const light = (dx, dy) => {
    const d = Math.hypot(dx, dy) || 1;
    sun.style.setProperty('--hx', `${50 + (dx / d) * 24}%`);
    sun.style.setProperty('--hy', `${50 + (dy / d) * 24}%`);
  };
  const step = () => {
    const k = grab ? 0.35 : 0.09;
    const damping = grab ? 0.55 : 0.82;
    for (const axis of ['x', 'y']) {
      vel[axis] = (vel[axis] + (target[axis] - pos[axis]) * k) * damping;
      pos[axis] += vel[axis];
    }
    sun.style.translate = `${pos.x.toFixed(2)}px ${pos.y.toFixed(2)}px`;
    const settled = Math.abs(vel.x) + Math.abs(vel.y) < 0.02 && Math.abs(target.x - pos.x) + Math.abs(target.y - pos.y) < 0.05;
    frame = settled ? 0 : requestAnimationFrame(step);
  };
  const run = () => { if (!frame) frame = requestAnimationFrame(step); };
  const reach = () => Math.min(220, panel.clientWidth * 0.4); // the phone band gives a shorter pull

  panel.addEventListener('pointermove', (e) => {
    const c = center();
    const dx = e.clientX - c.x;
    const dy = e.clientY - c.y;
    light(dx, dy);
    if (grab) {
      target.x = band(e.clientX - grab.x, reach());
      target.y = band(e.clientY - grab.y, reach());
    } else if (e.pointerType === 'mouse') {
      target.x = clamp(dx * 0.06, 22);
      target.y = clamp(dy * 0.06, 22);
    }
    run();
  });
  panel.addEventListener('pointerleave', () => {
    if (grab) return;
    target.x = 0; target.y = 0;
    sun.style.removeProperty('--hx'); sun.style.removeProperty('--hy');
    run();
  });
  sun.addEventListener('pointerdown', (e) => {
    grab = { x: e.clientX, y: e.clientY };
    sun.setPointerCapture(e.pointerId);
    sun.classList.add('is-held');
    if (e.pointerType === 'touch') navigator.vibrate?.(8); // a tiny tick on phones that support it
  });
  const release = () => {
    if (!grab) return;
    grab = null;
    target.x = 0; target.y = 0;
    sun.classList.remove('is-held');
    run();
  };
  sun.addEventListener('pointerup', release);
  sun.addEventListener('pointercancel', release);
  sun.classList.add('is-live');
}

document.querySelectorAll('.auth-sun').forEach(enhanceSun);

// Floating labels: a labelled text box, text area or select shows its label inside the box and lifts it onto the
// border once the box is focused or filled. Without JavaScript the label simply stays above the box.
const FLOAT_TYPES = /^(text|email|tel|url|search|password|number)$/;
function enhanceFloat(field) {
  const label = field.querySelector(':scope > label[for]');
  const control = label && document.getElementById(label.getAttribute('for'));
  if (!control || !field.contains(control)) return;
  const isSelect = control.matches('select');
  if (!isSelect && !control.matches('textarea') && !(control.matches('input') && FLOAT_TYPES.test(control.type))) return;
  const sync = () => field.classList.toggle('is-filled', isSelect || control.value !== '');
  field.classList.add('float');
  if (control.matches('textarea')) field.classList.add('float-area');
  sync();
  control.addEventListener('input', sync);
  control.addEventListener('change', sync);
  // The calendar popup, digit grouping and form reset set values without typing.
  field.addEventListener('click', () => setTimeout(sync));
  control.form?.addEventListener('reset', () => setTimeout(sync));
  window.addEventListener('pageshow', sync);
}

// ---------- day bar on /visits (D50) ----------

// The ruler runs left to right (LTR), so physical left and clientX maths are correct here.
function enhancePageBar(track) {
  const date = track.dataset.dayBarPage;
  const canAdd = track.hasAttribute('data-new');
  const scroller = track.parentElement;
  const minuteAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return null;
    const m = Math.round(((clientX - rect.left) / rect.width) * 1440 / 5) * 5;
    return Math.min(1435, Math.max(0, m));
  };

  // One hover card, shared by every block. The SVG <title> is removed so the card replaces it.
  const tip = el('div', { class: 'vbar-tip', hidden: true });
  track.append(tip);
  const hideTip = () => { tip.hidden = true; };
  const showTip = (rect) => {
    const span = `${fa(rect.dataset.time)} تا ${fa(rect.dataset.until)}` + (rect.hasAttribute('data-yesterday') ? '، از دیروز' : '');
    tip.replaceChildren(el('b', { text: rect.dataset.name }), el('span', { text: span }));
    tip.hidden = false;
    const left = (Number(rect.getAttribute('x')) / 1440) * track.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(left, track.offsetWidth - tip.offsetWidth))}px`;
  };

  let pointer = 'mouse';
  let touchBlock = null;
  // A tap anywhere but on a block dismisses the card (touch gives no pointerleave).
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.vbar-block')) return;
    hideTip();
    touchBlock = null;
  });
  const blocks =[...track.querySelectorAll('rect.vbar-block')];
  blocks.forEach((rect) => {
    rect.querySelector('title')?.remove();
    rect.addEventListener('pointerdown', (e) => { pointer = e.pointerType; });
    rect.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(rect); });
    rect.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
    // Touch: the first tap shows the card, a second tap on the same block follows the link.
    rect.addEventListener('click', (e) => {
      if (pointer === 'mouse' || touchBlock === rect) return;
      e.preventDefault();
      touchBlock = rect;
      showTip(rect);
    });
  });

  // Free-space guide and clicks: a click on a free spot starts a visit at that 5-minute time.
  const guide = canAdd ? el('div', { class: 'vbar-guide', hidden: true }, [el('span', { class: 'vbar-guide-label' })]) : null;
  if (guide) track.append(guide);
  track.addEventListener('pointermove', (e) => {
    if (!guide || e.pointerType !== 'mouse') return;
    if (e.target.closest?.('.vbar-block')) { guide.hidden = true; return; }
    const m = minuteAt(e.clientX);
    if (m === null) return;
    guide.hidden = false;
    guide.style.left = `${(m / 1440) * track.offsetWidth}px`;
    guide.firstChild.textContent = fa(hhmm(m));
  });
  track.addEventListener('pointerleave', () => { if (guide) guide.hidden = true; });
  track.addEventListener('click', (e) => {
    if (!canAdd || e.target.closest?.('.vbar-block')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const m = minuteAt(e.clientX);
    if (m === null) return;
    e.preventDefault();
    touchBlock = null;
    location.href = `/visits/new?d=${encodeURIComponent(date)}&t=${encodeURIComponent(hhmm(m))}`;
  });

  // Start the view at the first booking, else now (today), else 08:00.
  const starts = blocks.filter((rect) => !rect.hasAttribute('data-yesterday')).map((rect) => Number(rect.getAttribute('x')));
  const startMinute = starts.length ? Math.min(...starts) : track.hasAttribute('data-today') ? minutesNow() : 480;
  if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = (startMinute / 1440) * track.offsetWidth - 48;

  // The current-time line, kept in step with the clock.
  const nowLine = track.querySelector('.vbar-now');
  if (nowLine) {
    const place = () => {
      const m = minutesNow();
      nowLine.setAttribute('x1', m);
      nowLine.setAttribute('x2', m);
    };
    place();
    setInterval(place, 60000);
  }
}

// ---------- day bar dropdown on the visit form (D50) ----------

// Places a dropdown under its field (above it when there is no room below), then shifts it sideways into the viewport.
// Shared by the day bar and the length dial.
// On phones the bottom tab bar covers the foot of the viewport, so the room below ends above it.
function tabbarHeight() {
  const tab = document.querySelector('.tabbar');
  return tab && getComputedStyle(tab).display !== 'none' ? tab.offsetHeight : 0;
}
function placePop(anchor, pop) {
  pop.classList.remove('is-above');
  const limit = innerHeight - tabbarHeight();
  const box = anchor.getBoundingClientRect();
  if (box.bottom + pop.offsetHeight + 12 > limit && box.top > pop.offsetHeight + 12) pop.classList.add('is-above');
  pop.style.translate = '';
  const rect = pop.getBoundingClientRect();
  let dx = 0;
  if (rect.left < 16) dx = 16 - rect.left;
  else if (rect.right > innerWidth - 16) dx = innerWidth - 16 - rect.right;
  pop.style.translate = `${dx}px 0`;
}
// Scrolls the page just enough to show the whole popup above the tab bar.
function revealPop(pop) {
  const rect = pop.getBoundingClientRect();
  if (rect.bottom > innerHeight - tabbarHeight() || rect.top < 0) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    pop.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutesNow = () => {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
};
// "9:30", "09.30" in Persian or Latin digits, to minutes since midnight. Null when not a valid time.
function parseMinutes(text) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(toLatin(String(text ?? '')).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}
const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' });
let openDropdown = null; // closes the day bar or the length dial that is open, if any
let dayBarRefocus = false; // true while the script moves focus back to the time box, so the focus handler does not reopen it

function enhanceDayBar(input) {
  const dateBox = input.form?.elements.visit_date;
  const lengthBox = input.form?.elements.duration_min;
  if (!dateBox || !lengthBox) return;
  const fallback = document.getElementById('f-time-booked');
  if (fallback) fallback.hidden = true;

  const wrap = el('span', { class: 'field-addon dbar' });
  input.replaceWith(wrap);
  const button = el('button', {
    type: 'button', class: 'addon-btn', 'aria-label': 'انتخاب ساعت از نوار روز', title: 'انتخاب ساعت از نوار روز',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  }, [icon('i-clock')]);
  const pop = el('div', { class: 'dbar-pop', role: 'dialog', 'aria-label': 'نوار ساعت روز', hidden: true, tabindex: '-1' });
  const dateLabel = el('b', { class: 'dbar-date' });
  const pickLabel = el('span', { class: 'dbar-pick' });
  const closeBtn = el('button', { type: 'button', class: 'dbar-close', 'aria-label': 'بستن' }, [icon('i-x')]);
  const scroll = el('div', { class: 'dbar-scroll' });
  const track = el('div', {
    class: 'dbar-track', role: 'slider', tabindex: '0', 'aria-label': 'ساعت شروع ویزیت',
    'aria-valuemin': '0', 'aria-valuemax': '1435', 'aria-valuetext': 'انتخاب نشده',
  });
  const hourEls = Array.from({ length: 24 }, (_, h) => el('span', { class: 'dbar-hour', text: fa(String(h).padStart(2, '0')) }));
  const lane = el('div', { class: 'dbar-lane' });
  const ghost = el('div', { class: 'dbar-ghost', hidden: true });
  const knob = el('span', { class: 'dbar-knob' });
  const marker = el('div', { class: 'dbar-marker', hidden: true }, [knob]);
  const hover = el('div', { class: 'dbar-hover', hidden: true }, [el('span')]);
  const tip = el('div', { class: 'dbar-tip', hidden: true }, [el('b'), el('span')]);
  const statusEl = el('p', { class: 'dbar-status', 'aria-live': 'polite' });
  track.append(el('div', { class: 'dbar-hours' }, hourEls), lane);
  scroll.append(track);
  pop.append(
    el('div', { class: 'dbar-head' }, [el('div', { class: 'dbar-when' }, [dateLabel, pickLabel]), closeBtn]),
    scroll,
    tip,
    el('div', { class: 'dbar-foot' }, [
      statusEl,
      el('div', { class: 'dbar-keys', 'aria-hidden': 'true' }, [
        el('span', {}, [el('i', { class: 'key-booked' }), 'رزروشده']),
        el('span', {}, [el('i', { class: 'key-done' }), 'انجام‌شده']),
        el('span', {}, [el('i', { class: 'key-pick' }), 'ویزیت شما']),
      ]),
    ]),
  );
  wrap.append(input, button, pop);

  let hour = 120; // px per hour, read once at each open
  let bookings = [];
  let today = false;
  let note = null; // status line override: loading, bad date, or load failure
  let pick = null; // minutes since midnight, or null
  let internal = false; // true while the script writes the time box
  let blockEls = [];
  let nowEl = null;
  let drag = null;
  let lastPointer = 'mouse';
  let controller = null;

  const px = (m) => (m * hour) / 60;
  const duration = () => Number(lengthBox.value) || 15;
  const clash = () => (pick === null ? null : bookings.find((b) => b.start < pick + duration() && pick < b.end) || null);
  // null while the ruler has no width (hidden), so callers do nothing.
  const minuteAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return null;
    const m = Math.round(((clientX - rect.left) / rect.width) * 1440 / 5) * 5;
    return Math.min(1435, Math.max(0, m));
  };
  const refocus = () => {
    dayBarRefocus = true;
    input.focus();
    dayBarRefocus = false;
  };

  // Booked visit tip: name, time span and length, and «از دیروز» for a tail from the day before.
  const hideTip = () => {
    tip.hidden = true;
    tip.classList.remove('is-shown');
  };
  function showTip(node) {
    const parts = [`${fa(node.dataset.time)} تا ${fa(node.dataset.until)}`, `${fa(node.dataset.len)} دقیقه`];
    if (node.hasAttribute('data-yesterday')) parts.push('از دیروز');
    tip.firstChild.textContent = node.dataset.name;
    tip.lastChild.textContent = parts.join('، ');
    tip.hidden = false;
    tip.classList.add('is-shown');
    const b = node.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(b.left - p.left, pop.clientWidth - tip.offsetWidth))}px`;
    tip.style.top = `${b.top - p.top}px`;
  }

  function renderBlocks() {
    blockEls = bookings.map((b) => {
      const node = el('div', {
        class: `dbar-block${b.status === 'done' ? ' is-done' : ''}`,
        'data-name': b.name, 'data-time': b.time, 'data-until': b.until, 'data-len': b.end - b.start,
        'data-yesterday': b.fromYesterday,
      });
      node.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(node); });
      node.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
      node.addEventListener('click', () => {
        if (lastPointer === 'mouse') return;
        if (tip.hidden) showTip(node);
        else hideTip();
      });
      return node;
    });
    nowEl = today ? el('div', { class: 'dbar-now' }) : null;
    lane.replaceChildren(...blockEls, ...(nowEl ? [nowEl] : []), ghost, marker, hover);
  }

  function renderStatus() {
    statusEl.classList.remove('is-clash');
    if (note) {
      statusEl.textContent = note;
    } else if (pick === null) {
      statusEl.textContent = 'روی جای آزاد نوار بزنید؛ ساعت در کادر نوشته می‌شود.';
    } else {
      const c = clash();
      statusEl.classList.toggle('is-clash', Boolean(c));
      if (c) {
        statusEl.textContent = `با ویزیت ساعت ${fa(c.time)} تا ${fa(c.until)} هم‌پوشانی دارد.`;
      } else if (pick + duration() > 1440) {
        // The bar does not load the next day, so the overrun is checked by the server on save.
        statusEl.textContent = 'ادامه‌ی این ویزیت به فردا می‌رسد؛ هم‌پوشانی با فردا هنگام ذخیره بررسی می‌شود.';
      } else {
        statusEl.textContent = `آزاد است: ${fa(hhmm(pick))} تا ${fa(hhmm(pick + duration()))}`;
      }
    }
  }

  function paintPick(glide) {
    const on = pick !== null;
    marker.hidden = !on;
    ghost.hidden = !on;
    marker.classList.toggle('is-gliding', glide && on);
    ghost.classList.toggle('is-gliding', glide && on);
    ghost.classList.toggle('is-clash', Boolean(clash()));
    if (on) {
      marker.style.left = `${px(pick)}px`;
      ghost.style.left = `${px(pick)}px`;
      ghost.style.width = `${px(Math.min(duration(), 1440 - pick))}px`; // clipped at 24:00
      track.setAttribute('aria-valuenow', String(pick));
      track.setAttribute('aria-valuetext', fa(hhmm(pick)));
      pickLabel.textContent = pick + duration() > 1440
        ? `${fa(hhmm(pick))} تا فردا ${fa(hhmm(pick + duration() - 1440))}`
        : `${fa(hhmm(pick))} تا ${fa(hhmm(pick + duration()))}`;
    } else {
      track.removeAttribute('aria-valuenow');
      track.setAttribute('aria-valuetext', 'انتخاب نشده');
      pickLabel.textContent = 'ساعت شروع را روی نوار بزنید';
    }
    renderStatus();
  }

  // Positions everything from the data and the current hour width.
  function paint() {
    track.style.width = `${24 * hour}px`;
    hourEls.forEach((h, i) => { h.style.left = `${i * hour}px`; });
    blockEls.forEach((node, i) => {
      node.style.left = `${px(bookings[i].start)}px`;
      node.style.width = `${px(bookings[i].end - bookings[i].start)}px`;
    });
    if (nowEl) nowEl.style.left = `${px(minutesNow())}px`;
    paintPick(false);
  }

  function setPick(m, glide) {
    pick = m;
    internal = true;
    input.value = hhmm(m);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    internal = false;
    paintPick(glide);
  }
  function keepVisible(m) {
    const x = px(m);
    if (x < scroll.scrollLeft + 24 || x > scroll.scrollLeft + scroll.clientWidth - 24) scroll.scrollLeft = x - scroll.clientWidth / 3;
  }

  input.addEventListener('input', () => {
    if (internal) return;
    pick = parseMinutes(input.value);
    if (pick !== null) keepVisible(pick);
    paintPick(true);
  });
  lengthBox.addEventListener('change', () => paintPick(false));

  // Loads the day for the date box. A newer request aborts the older one.
  async function load() {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    pop.setAttribute('aria-busy', 'true');
    note = 'در حال بارگذاری…';
    renderStatus();
    const query = `d=${encodeURIComponent(dateBox.value.trim())}`
      + (input.dataset.dayBar ? `&exclude=${encodeURIComponent(input.dataset.dayBar)}` : '');
    try {
      const res = await fetch(`/visits/day?${query}`, { headers: { accept: 'application/json' }, signal: mine.signal });
      if (res.status === 400) {
        bookings = [];
        today = false;
        note = 'تاریخ را درست وارد کنید تا نوار ساعت پر شود.';
        dateLabel.textContent = '';
      } else if (res.ok) {
        const data = await res.json();
        if (mine.signal.aborted) return;
        bookings = data.bookings;
        today = data.today;
        note = null;
        dateLabel.textContent = dayFmt.format(new Date(`${data.date}T12:00:00`));
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (err.name === 'AbortError' || mine.signal.aborted) return;
      bookings = [];
      today = false;
      note = 'نوار ساعت بارگذاری نشد؛ ساعت را تایپ کنید.';
      dateLabel.textContent = '';
      if (fallback) fallback.hidden = false;
    }
    if (controller !== mine) return;
    pop.removeAttribute('aria-busy');
    renderBlocks();
    paint();
  }

  // The first booking (not a tail from yesterday) starts 30 minutes early; with none, 08:00.
  function scrollToStart() {
    const first = bookings.find((b) => !b.fromYesterday);
    const m = pick ?? (first ? Math.max(0, first.start - 30) : 480);
    scroll.scrollLeft = px(m) - scroll.clientWidth / 3;
  }

  function open() {
    if (!pop.hidden || dayBarRefocus) return;
    closePicker();
    if (openDropdown) openDropdown();
    hour = matchMedia('(max-width: 600px)').matches ? 96 : 120;
    pick = parseMinutes(input.value); // the box's time shows on open (edit form, or ?t= from /visits)
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openDropdown = close;
    paint();
    placePop(wrap, pop);
    requestAnimationFrame(() => pop.classList.add('is-open'));
    load().then(() => {
      if (pop.hidden) return;
      paintPick(false);
      scrollToStart();
      placePop(wrap, pop);
      revealPop(pop);
    });
  }
  function close() {
    if (pop.hidden) return;
    pop.classList.remove('is-open');
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    hideTip();
    if (openDropdown === close) openDropdown = null;
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  closeBtn.addEventListener('click', () => { close(); refocus(); });
  dateBox.addEventListener('change', () => { if (!pop.hidden) load(); });
  wrap.addEventListener('focusout', () => {
    setTimeout(() => { if (!pop.hidden && !wrap.contains(document.activeElement)) close(); }, 0);
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); });
  window.addEventListener('resize', () => { if (!pop.hidden) placePop(wrap, pop); });
  // Scrolling the ruler moves the blocks under a shown card, so hide it and the free-space guide.
  scroll.addEventListener('scroll', () => { hideTip(); hover.hidden = true; }, { passive: true });
  closeBtn.tabIndex = -1; // Esc closes; the button stays clickable without a Tab stop
  // Esc closes from anywhere in the widget, the clock button included (it keeps focus after a mouse click).
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); close(); refocus(); } });

  // Picking on the ruler. Blocks never pick; a mouse picks on press and follows the drag; touch picks on a tap only.
  knob.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    drag = { kind: 'knob', id: e.pointerId };
    knob.setPointerCapture(e.pointerId);
  });
  lane.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    if (e.target.closest('.dbar-block')) return;
    hideTip();
    const m = minuteAt(e.clientX);
    if (m === null) return;
    if (e.pointerType === 'mouse') {
      drag = { kind: 'mouse', id: e.pointerId };
      lane.setPointerCapture(e.pointerId);
      setPick(m, true);
    } else {
      drag = { kind: 'touch', id: e.pointerId, x: e.clientX, m, moved: false };
    }
  });
  lane.addEventListener('pointermove', (e) => {
    if (drag) {
      hover.hidden = true;
      if (drag.kind === 'touch') {
        if (Math.abs(e.clientX - drag.x) >= 8) drag.moved = true;
      } else if (e.pointerId === drag.id) {
        const m = minuteAt(e.clientX);
        if (m !== null) setPick(m, false);
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (e.target.closest('.dbar-block')) { hover.hidden = true; return; }
    const m = minuteAt(e.clientX);
    if (m === null) return;
    hover.hidden = false;
    hover.style.left = `${px(m)}px`;
    hover.firstChild.textContent = fa(hhmm(m));
  });
  lane.addEventListener('pointerleave', () => { hover.hidden = true; });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.kind === 'touch' && !drag.moved && drag.m !== null) setPick(drag.m, true);
    drag = null;
  };
  lane.addEventListener('pointerup', endDrag);
  lane.addEventListener('pointercancel', () => { drag = null; });

  // Keyboard on the ruler: arrows move 5 minutes, Page Up and Down an hour, Home and End the day, Enter closes.
  track.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(); refocus(); return; }
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const base = pick ?? 480;
    let next = Math.min(1435, Math.max(0, base + (step ?? 0)));
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = 1435;
    keepVisible(next);
    setPick(next, true);
  });

  renderBlocks();
}

// ---------- length dial on the visit form (D51) ----------

// A clock-face length picker for the visit's duration select. The select stays in the form and is the source of truth.
// Values up to 60 sit on the ring, 75 and 90 are pills under it.
function svgNode(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function enhanceDial(select) {
  const values = [...select.options].map((o) => Number(o.value));
  const ringValues = values.filter((n) => n <= 60);
  const pillValues = values.filter((n) => n > 60);
  let v = Number(select.value) || values[0] || 15;

  const wrap = el('span', { class: 'dial' });
  select.replaceWith(wrap);
  select.hidden = true;
  const label = document.querySelector(`label[for="${select.id}"]`);
  if (label) label.id = `${select.id}-label`;
  const btn = el('button', {
    type: 'button', class: 'select dial-btn', id: `${select.id}-btn`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  });
  if (label) {
    btn.setAttribute('aria-labelledby', `${label.id} ${btn.id}`);
    label.addEventListener('click', (e) => { e.preventDefault(); btn.focus(); });
  }
  const pop = el('div', { class: 'dial-pop', role: 'dialog', 'aria-label': 'مدت ویزیت', hidden: true, tabindex: '-1' });
  const face = el('div', { class: 'dial-face' });
  const arc = svgNode('circle', { class: 'dial-arc', cx: 116, cy: 116, r: 100, pathLength: 60, transform: 'rotate(-90 116 116)' });
  const extraArc = svgNode('circle', { class: 'dial-extra', cx: 116, cy: 116, r: 110, pathLength: 60, transform: 'rotate(-90 116 116)' });
  const knobDot = svgNode('circle', { class: 'dial-knob', r: 9 });
  const ring = svgNode('svg', { class: 'dial-ring', viewBox: '0 0 232 232', 'aria-hidden': 'true', focusable: 'false' });
  ring.append(
    svgNode('circle', { class: 'dial-plate', cx: 116, cy: 116, r: 112 }),
    svgNode('circle', { class: 'dial-track', cx: 116, cy: 116, r: 100 }),
    arc, extraArc, knobDot,
  );
  const numBtns = ringValues.map((n) => {
    // Clock position: 5 at one o'clock, 60 at twelve. Percentages keep the numbers on the face at any size.
    const a = (n / 60) * 2 * Math.PI;
    const b = el('button', { type: 'button', class: 'dial-num', 'aria-label': `${fa(n)} دقیقه`, 'aria-pressed': 'false', text: fa(n) });
    b.dataset.value = String(n);
    b.style.left = `${50 + 31.03 * Math.sin(a)}%`;
    b.style.top = `${50 - 31.03 * Math.cos(a)}%`;
    b.addEventListener('click', () => setValue(n));
    return b;
  });
  const pillBtns = pillValues.map((n) => {
    const b = el('button', { type: 'button', class: 'dial-pill', 'aria-label': `${fa(n)} دقیقه`, 'aria-pressed': 'false', text: fa(n) });
    b.dataset.value = String(n);
    b.addEventListener('click', () => setValue(n));
    return b;
  });
  const allBtns = [...numBtns, ...pillBtns];
  const valueEl = el('b', { class: 'dial-value' });
  face.append(ring, ...numBtns, el('div', { class: 'dial-center', 'aria-hidden': 'true' }, [valueEl, el('span', { class: 'dial-unit', text: 'دقیقه' })]));
  pop.append(face, el('div', { class: 'dial-more' }, [el('span', { text: 'بیش از یک ساعت' }), el('div', { class: 'dial-pills' }, pillBtns)]));
  wrap.append(select, btn, pop);

  function paint() {
    const onRing = v <= 60;
    const a = ((onRing ? v : v - 60) / 60) * 2 * Math.PI;
    const r = onRing ? 100 : 110;
    arc.setAttribute('stroke-dasharray', `${Math.min(v, 60)} 60`);
    extraArc.setAttribute('stroke-dasharray', `${Math.max(0, v - 60)} 60`);
    extraArc.style.display = onRing ? 'none' : '';
    knobDot.setAttribute('cx', (116 + r * Math.sin(a)).toFixed(2));
    knobDot.setAttribute('cy', (116 - r * Math.cos(a)).toFixed(2));
    valueEl.textContent = fa(v);
    btn.textContent = `${fa(v)} دقیقه`;
    for (const b of allBtns) {
      const on = Number(b.dataset.value) === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1; // roving tabindex: one Tab stop on the dial, the current value
    }
  }
  function setValue(n) {
    v = n;
    select.value = String(n);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    paint();
  }
  const focusValue = (n) => allBtns.find((b) => Number(b.dataset.value) === n)?.focus();

  // Dragging the ring: the angle from twelve, snapped to 5 minutes. The centre readout is not a drag target.
  let dragging = false;
  const pointAt = (e) => {
    const rect = face.getBoundingClientRect();
    const x = e.clientX - (rect.left + rect.width / 2);
    const y = e.clientY - (rect.top + rect.height / 2);
    if (Math.hypot(x, y) < rect.width * 0.22) return null;
    let theta = Math.atan2(x, -y);
    if (theta < 0) theta += 2 * Math.PI;
    const n = Math.round((theta / (2 * Math.PI)) * 12) * 5;
    return n === 0 ? 60 : n;
  };
  face.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dial-num')) return;
    const n = pointAt(e);
    if (n === null) return;
    dragging = true;
    face.setPointerCapture(e.pointerId);
    face.classList.add('is-dragging');
    setValue(n);
  });
  face.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const n = pointAt(e);
    if (n !== null && n !== v) setValue(n);
  });
  const endDrag = () => {
    dragging = false;
    face.classList.remove('is-dragging');
  };
  face.addEventListener('pointerup', endDrag);
  face.addEventListener('pointercancel', endDrag);

  function open() {
    if (!pop.hidden) return;
    closePicker();
    if (openDropdown) openDropdown();
    v = Number(select.value) || v; // an outside change to the select shows on open
    paint();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openDropdown = close;
    placePop(wrap, pop);
    revealPop(pop);
    requestAnimationFrame(() => pop.classList.add('is-open'));
  }
  function close() {
    if (pop.hidden) return;
    pop.classList.remove('is-open');
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (openDropdown === close) openDropdown = null;
  }
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (pop.hidden) open();
    focusValue(v);
  });
  // Arrow keys step through the values. Escape closes from anywhere in the widget (see wrap below).
  pop.addEventListener('keydown', (e) => {
    const i = values.indexOf(v);
    let j;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') j = i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') j = i - 1;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = values.length - 1;
    else return;
    e.preventDefault();
    const next = values[Math.min(values.length - 1, Math.max(0, j))];
    setValue(next);
    focusValue(next);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); close(); btn.focus(); }
  });
  wrap.addEventListener('focusout', () => {
    setTimeout(() => { if (!pop.hidden && !wrap.contains(document.activeElement)) close(); }, 0);
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); });
  window.addEventListener('resize', () => { if (!pop.hidden) placePop(wrap, pop); });
  // A form reset restores the select's default, so the dial follows it.
  select.form?.addEventListener('reset', () => setTimeout(() => { v = Number(select.value) || v; paint(); }));
  paint();
}

// ---------- wire up ----------

document.querySelectorAll('input[type="password"]').forEach(enhancePassword);
document.querySelectorAll('input[data-jalali]').forEach(enhanceDate);
document.querySelectorAll('.qb-rule').forEach(enhanceRule);
document.querySelectorAll('select[data-status-cycle]').forEach(enhanceStatus);
document.querySelectorAll('button[data-copy]').forEach(enhanceCopy);
document.querySelectorAll('textarea[data-sms-template]').forEach(enhanceSmsTemplate);
document.querySelectorAll('input.input-money').forEach(enhanceMoney);
document.querySelectorAll('input[type="file"][data-dropzone]').forEach(enhanceDropzone);
document.querySelectorAll('.vbar-track[data-day-bar-page]').forEach(enhancePageBar);
document.querySelectorAll('input[data-day-bar]').forEach(enhanceDayBar);
document.querySelectorAll('select[data-dial]').forEach(enhanceDial);
// PDF documents (D30): the print button stays hidden without JavaScript, where the page shows a Ctrl+P hint instead.
document.querySelectorAll('.field').forEach(enhanceFloat);
document.querySelectorAll('button[data-print]').forEach((button) => {
  button.hidden = false;
  button.addEventListener('click', () => window.print());
});
document.querySelectorAll('input[type="file"][data-autosubmit]').forEach((input) => {
  input.addEventListener('change', () => withBusy(input, async () => {
    if ((await prepareFiles(input)).length) setTimeout(() => input.form.requestSubmit());
  }));
});
