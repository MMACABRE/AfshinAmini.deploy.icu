-- D36: changing a patient's code by hand is a new permission flag. Users on the «مدیر» preset get it, like the
-- SMS flags in 011, so their permissions still match the preset; the owner always has every flag.
UPDATE users SET perms = json_set(perms, '$.flags', json_insert(json_extract(perms, '$.flags'), '$[#]', 'patient_code'))
  WHERE role = 'admin' AND json_valid(perms) AND json_type(perms, '$.flags') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(perms, '$.flags') WHERE value = 'patient_code');
