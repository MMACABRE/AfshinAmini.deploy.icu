-- Owner 2026-10-27: the default clinic name is «KLERK | کلرک». A clinic still on the old default «کلینیک» gets it;
-- a name a clinic chose stays.
UPDATE settings SET value = 'KLERK | کلرک' WHERE key = 'clinic_name' AND value = 'کلینیک';
