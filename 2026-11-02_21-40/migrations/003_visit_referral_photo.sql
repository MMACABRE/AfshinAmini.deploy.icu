-- User feedback 2026-10-16: sex is only female or male; new fields for the reason of visit and the referral;
-- an optional profile photo. The CHECK on sex in 001 still allows 'other', so the app enforces the shorter list.
UPDATE patients SET sex = NULL WHERE sex NOT IN ('female', 'male');
ALTER TABLE patients ADD COLUMN visit_reason TEXT;
ALTER TABLE patients ADD COLUMN referral TEXT;
-- Filename of the photo inside data/patients/<code>/ (an ordinary JPG or PNG there); NULL means no photo.
ALTER TABLE patients ADD COLUMN photo TEXT;
