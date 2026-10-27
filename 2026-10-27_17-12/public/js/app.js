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

// Replaces the input's file with a shrunk copy when needed. Resolves to the file that will be uploaded.
async function prepareFile(input) {
  const file = input.files[0];
  if (!file) return null;
  let out = file;
  try {
    out = await shrinkImage(file);
    if (out !== file) {
      const dt = new DataTransfer();
      dt.items.add(out);
      input.files = dt.files;
    }
  } catch {
    out = file;
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
    const file = input.files[0];
    zone.classList.toggle('has-file', !!file);
    if (!file) { label.textContent = ''; return; }
    const big = file.size > SHRINK_LIMIT && isShrinkable(file);
    if (big) {
      zone.classList.add('is-busy');
      label.textContent = `در حال کوچک‌سازی ${file.name}…`;
    }
    const out = await prepareFile(input);
    zone.classList.remove('is-busy');
    label.textContent = big && out !== file
      ? `${out.name} · از ${mbText(file.size)} به ${mbText(out.size)} کوچک شد`
      : `${out.name} · ${mbText(out.size)}`;
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

// ---------- wire up ----------

document.querySelectorAll('input[type="password"]').forEach(enhancePassword);
document.querySelectorAll('input[data-jalali]').forEach(enhanceDate);
document.querySelectorAll('.qb-rule').forEach(enhanceRule);
document.querySelectorAll('select[data-status-cycle]').forEach(enhanceStatus);
document.querySelectorAll('button[data-copy]').forEach(enhanceCopy);
document.querySelectorAll('textarea[data-sms-template]').forEach(enhanceSmsTemplate);
document.querySelectorAll('input.input-money').forEach(enhanceMoney);
document.querySelectorAll('input[type="file"][data-dropzone]').forEach(enhanceDropzone);
// PDF documents (D30): the print button stays hidden without JavaScript, where the page shows a Ctrl+P hint instead.
document.querySelectorAll('.field').forEach(enhanceFloat);
document.querySelectorAll('button[data-print]').forEach((button) => {
  button.hidden = false;
  button.addEventListener('click', () => window.print());
});
document.querySelectorAll('input[type="file"][data-autosubmit]').forEach((input) => {
  input.addEventListener('change', () => withBusy(input, async () => {
    if (await prepareFile(input)) setTimeout(() => input.form.requestSubmit());
  }));
});
