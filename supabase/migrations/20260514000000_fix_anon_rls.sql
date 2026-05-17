-- ─── Fix: Anon-Policies auf access_token scope ───────────────────────────────
--
-- Zweck: Die bisherigen anon-Policies auf time_entry und payroll_confirmation
--   verwendeten USING(true)/WITH CHECK(true) — jeder mit dem öffentlichen Anon-Key
--   konnte alle Datensätze lesen und schreiben.
--
-- Neue Strategie: Der Supabase-Client sendet den access_token als HTTP-Header
--   `x-access-token` mit jeder Anfrage (gesetzt in packages/core/src/services/supabase.ts
--   beim Laden einer /t/:token-Seite). Eine SECURITY DEFINER-Funktion liest den Header
--   und gibt die zugehörige Assistant-ID zurück. Policies prüfen assistant_id dagegen.
--
-- Anwenden:
--   supabase db push  (oder im Supabase Studio unter SQL Editor ausführen)
--
-- Manuelle Verifikation im Supabase Studio:
--   1. Öffne SQL Editor.
--   2. Führe aus (simuliert einen Request ohne Token):
--        SELECT current_assistant_id();   -- muss NULL ergeben
--   3. Setze den GUC für einen Test-Token (z.B. 'testtoken'):
--        SET LOCAL request.headers = '{"x-access-token":"<echter_access_token>"}';
--        SELECT current_assistant_id();   -- muss die UUID des passenden Assistant ergeben
--   4. Prüfe, dass eine SELECT auf time_entry ohne Header leer zurückkommt:
--        SET LOCAL request.headers = '{}';
--        SET LOCAL role = anon;
--        SELECT count(*) FROM time_entry;  -- muss 0 ergeben (keine Zeilen sichtbar)

-- ─── Helper-Funktion ──────────────────────────────────────────────────────────
-- SECURITY DEFINER: läuft als Eigentümer-Rolle und umgeht RLS beim Lookup.
-- SET search_path = public: verhindert search_path-Injection-Angriffe.
CREATE OR REPLACE FUNCTION public.current_assistant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text;
  v_id    uuid;
BEGIN
  BEGIN
    v_token := current_setting('request.headers', true)::json->>'x-access-token';
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF v_token IS NULL OR v_token = '' THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_id
    FROM public.assistant
   WHERE access_token = v_token
   LIMIT 1;
  RETURN v_id;
END;
$$;

-- ─── time_entry: alte offene Policies entfernen ───────────────────────────────
DROP POLICY IF EXISTS "time_entry_assistant_insert" ON public.time_entry;
DROP POLICY IF EXISTS "time_entry_assistant_select" ON public.time_entry;
DROP POLICY IF EXISTS "time_entry_assistant_update" ON public.time_entry;

-- ─── time_entry: neue auf access_token beschränkte Policies ──────────────────
CREATE POLICY "time_entry_anon_select" ON public.time_entry
  FOR SELECT TO anon
  USING (assistant_id = current_assistant_id());

CREATE POLICY "time_entry_anon_insert" ON public.time_entry
  FOR INSERT TO anon
  WITH CHECK (assistant_id = current_assistant_id());

CREATE POLICY "time_entry_anon_update" ON public.time_entry
  FOR UPDATE TO anon
  USING  (assistant_id = current_assistant_id())
  WITH CHECK (assistant_id = current_assistant_id());

-- ─── payroll_confirmation: alte offene Policy entfernen ──────────────────────
DROP POLICY IF EXISTS "payroll_confirmation_assistant" ON public.payroll_confirmation;

-- ─── payroll_confirmation: neue auf access_token beschränkte Policies ─────────
CREATE POLICY "payroll_confirmation_anon_select" ON public.payroll_confirmation
  FOR SELECT TO anon
  USING (assistant_id = current_assistant_id());

CREATE POLICY "payroll_confirmation_anon_update" ON public.payroll_confirmation
  FOR UPDATE TO anon
  USING  (assistant_id = current_assistant_id())
  WITH CHECK (assistant_id = current_assistant_id());
