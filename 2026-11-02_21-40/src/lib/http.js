// Small helpers shared by the route files.

// A row id from a URL or form value, or 0 (never a real row) for anything else. At most 15 digits, so the
// number is exact in JavaScript.
export const idOf = (s) => (/^[1-9]\d{0,14}$/.test(String(s)) ? Number(s) : 0);

// The 404 page with a Persian message.
export const notFound = (res, message = 'صفحه‌ی مورد نظر پیدا نشد.') => res.status(404).render('error', { status: 404, message });
