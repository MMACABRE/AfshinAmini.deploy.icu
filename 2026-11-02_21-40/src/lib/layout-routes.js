// The save, undo and reset routes of one layout (D52-D54). The patient form and the dashboard both use it, so the
// rule that an empty POST cannot wipe a layout is written once.
import { checkLayout, saveLayout, undoLayout, resetLayout, layoutKind } from './layouts.js';

// path: the layout page's URL; back(query): where a success goes; fail(req, res, message): the 422 page.
export function layoutRoutes(router, name, { path, back, fail }) {
  router.post(path, (req, res) => {
    const { db } = req.app.locals;
    const kind = layoutKind(name);
    const json = typeof req.body.layout === 'string';
    // A JSON layout, or the page's own form (marker fallback=1 with its order fields). Anything else is refused.
    if (!json && !(req.body.fallback === '1' && kind.fieldsOk(req.body))) {
      return fail(req, res, 'چیدمان ذخیره نشد. فرم را دوباره بفرستید.');
    }
    const checked = checkLayout(db, name, json ? req.body.layout : kind.fromFields(db, req.body));
    if (checked.error) return fail(req, res, checked.error);
    saveLayout(db, name, checked.layout, req.user.id);
    res.redirect(303, back('saved=1'));
  });

  router.post(`${path}/undo`, (req, res) => {
    const ok = undoLayout(req.app.locals.db, name, req.user.id);
    res.redirect(303, back(`undone=${ok ? 1 : 0}`));
  });

  router.post(`${path}/reset`, (req, res) => {
    resetLayout(req.app.locals.db, name, req.user.id);
    res.redirect(303, back('reset=1'));
  });
}
