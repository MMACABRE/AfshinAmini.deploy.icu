// "Contact us": how to reach the developer when something goes wrong. Open to everyone, so it is mounted before
// requireUser; signed-in users see it inside the app shell, visitors on the sign-in side. It holds no patient data.
import { Router } from 'express';

const router = Router();

// Shown on the page and used for the tel: and mailto: links.
export const CONTACT = {
  name: 'حسین هویسی',
  phone: '+989165069060',
  phoneShown: '+98 916 506 9060',
  email: 'hosseinhoveysi@gmail.com',
};

router.get('/contact', (req, res) => {
  const { db } = req.app.locals;
  if (req.user) {
    // The sidebar shows the patient count and the user's name, so the browser must not keep this page either.
    res.set('Cache-Control', 'private, no-store');
    res.locals.patientCount = db.prepare("SELECT COUNT(*) AS n FROM patients WHERE status <> 'archived'").get().n;
  }
  res.render('contact', { active: 'contact', contact: CONTACT });
});

export default router;
