-- One term name per class (adversarial review, task 3.2): two quick submits
-- of the New term form (a double click, two tabs) could each pass the
-- "name already taken" check and create the same term — and its weekly
-- sessions — twice. The database now refuses the second one; the admin
-- pages turn the refusal into a plain message. Case-insensitive, like the
-- check the pages already make.
CREATE UNIQUE INDEX idx_terms_class_name ON terms (class_id, name COLLATE NOCASE);
