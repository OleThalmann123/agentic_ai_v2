-- Add free-text note field to time_entry for optional activity descriptions
ALTER TABLE public.time_entry ADD COLUMN IF NOT EXISTS category_note text;
