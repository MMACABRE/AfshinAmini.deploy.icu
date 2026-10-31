// IranPayamak client. Fixed base URL, API key in a header, no redirects, short timeout. Nothing here logs or returns the key.
// Every call returns a plain object and never throws:
//   balance -> { ok: true, count, amount } | { ok: false, code, text }
//   send    -> { ok: true, id, status } | { ok: false, code, text, retry }   (retry: the request provably never left this machine)

export const BASE_URL = 'https://api.iranpayamak.com/ws/v1/';
const TIMEOUT_MS = 15000;
const NEVER_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH']);
const ACCEPTED = new Set(['pending-approval', 'in-queue', 'sent', 'init']);

const pick = (o, a, b) => o?.[a] ?? o?.[b];
// The provider's `message` is a string, or an object of field -> [texts] on a validation error.
const flat = (m) => (m && typeof m === 'object' ? Object.values(m).flat().join(' ') : m);
const short = (s) => String(flat(s) ?? '').replace(/\s+/g, ' ').slice(0, 120);

// code = what the log keeps; text = Persian reason shown to staff.
function failure(code, text, retry = false) { return { ok: false, code, text, retry }; }

function connectionFailure(e) {
  const c = e?.cause?.code ?? e?.code;
  if (NEVER_SENT.has(c)) return failure(c, 'اتصال به سرویس پیامک برقرار نشد.', true);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return failure('timeout', 'پاسخی از سرویس پیامک نرسید؛ نتیجه نامشخص است.');
  return failure('network', 'ارتباط با سرویس پیامک قطع شد؛ نتیجه نامشخص است.');
}

async function call(fetchFn, apiKey, method, route, body) {
  let res;
  try {
    res = await fetchFn(BASE_URL + route, {
      method,
      headers: { 'Api-Key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { return { error: connectionFailure(e) }; }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { res, json };
}

export function createProvider(fetchFn = globalThis.fetch) {
  return {
    async balance(apiKey) {
      const { res, json, error } = await call(fetchFn, apiKey, 'GET', 'account/balance');
      if (error) return error;
      if (res.status === 401 || res.status === 403) return failure('auth', 'کلید پیامک پذیرفته نشد.');
      const d = json?.data;
      const count = Number(pick(d, 'balance_count', 'balanceCount'));
      if (!res.ok || !Number.isFinite(count)) return failure(`http-${res.status}`, 'موجودی از سرویس پیامک خوانده نشد.');
      return { ok: true, count, amount: Number(pick(d, 'balance_amount', 'balanceAmount')) || 0 };
    },

    async send(apiKey, line, phone, text) {
      const { res, json, error } = await call(fetchFn, apiKey, 'POST', 'sms/simple', { text, line_number: String(line), recipients: [phone], number_format: 'persian' });
      if (error) return error;
      if (res.status === 401 || res.status === 403) return failure('auth', 'کلید پیامک پذیرفته نشد.');
      // 5xx and anything unreadable: the provider may have queued it, so the caller must not resend on its own.
      if (res.status >= 500) return failure(`http-${res.status}`, 'سرویس پیامک خطا داد؛ نتیجه نامشخص است.');
      const d = json?.data;
      const status = String(d?.status ?? '');
      if (status === 'insufficient-balance') return failure('no-credit', 'اعتبار کافی نیست.');
      if (res.ok && json?.status !== 'error' && (ACCEPTED.has(status) || d?.id != null)) {
        return { ok: true, id: d?.id == null ? null : String(d.id), status };
      }
      return failure(`http-${res.status}`, short(json?.message) || 'ارسال پذیرفته نشد.');
    },
  };
}
