-- Choice ids are never reused, even after the highest one is removed. This column keeps the highest id ever handed
-- out for a choice box (0 = none yet); the next id is the larger of this and the highest id in `choices`.
ALTER TABLE custom_boxes ADD COLUMN choice_seq INTEGER NOT NULL DEFAULT 0;
