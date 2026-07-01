-- Term labelling for class sessions (e.g. "Term 3"). Groups the public class
-- list and the admin schedule into bookable terms; blank means unlabelled.
ALTER TABLE class_sessions ADD COLUMN term_label TEXT NOT NULL DEFAULT '';
