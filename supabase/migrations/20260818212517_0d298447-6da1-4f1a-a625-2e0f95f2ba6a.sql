CREATE OR REPLACE FUNCTION public.game_crash_players(_round bigint, _limit int DEFAULT 8, _exclude bigint DEFAULT NULL)
RETURNS TABLE (name text, photo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(NULLIF(btrim(p.first_name), ''), NULLIF(p.username, ''), 'Player') AS name,
    p.photo_url
  FROM public.profiles p
  WHERE p.telegram_id IS NOT NULL
    AND (_exclude IS NULL OR p.telegram_id <> _exclude)
    AND COALESCE(p.is_banned, false) = false
  ORDER BY md5(p.telegram_id::text || '-' || _round::text)
  LIMIT LEAST(GREATEST(_limit, 1), 20)
$$;

GRANT EXECUTE ON FUNCTION public.game_crash_players(bigint, int, bigint) TO anon, authenticated, service_role;