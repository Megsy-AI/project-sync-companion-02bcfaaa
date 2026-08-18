CREATE TABLE public.game_crash_rounds (
  round_id bigint PRIMARY KEY,
  crash_multiplier numeric NOT NULL CHECK (crash_multiplier >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.game_crash_rounds TO anon, authenticated;
GRANT ALL ON public.game_crash_rounds TO service_role;

ALTER TABLE public.game_crash_rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Crash round results are public"
ON public.game_crash_rounds
FOR SELECT
TO anon, authenticated
USING (true);

CREATE OR REPLACE FUNCTION public.game_crash_round_result(_round_id bigint)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _crash numeric;
  _u double precision;
BEGIN
  SELECT crash_multiplier INTO _crash
  FROM public.game_crash_rounds
  WHERE round_id = _round_id;

  IF _crash IS NOT NULL THEN
    RETURN _crash;
  END IF;

  _u := ('x' || substr(md5(_round_id::text || '-nova-crash-v1'), 1, 13))::bit(52)::bigint::double precision / 4503599627370496.0;
  IF _u < 0.03 THEN
    _crash := 1.00;
  ELSE
    _crash := round(LEAST(1000, GREATEST(1.01, (0.96 / GREATEST(_u, 0.0001))::numeric)), 2);
  END IF;

  INSERT INTO public.game_crash_rounds (round_id, crash_multiplier)
  VALUES (_round_id, _crash)
  ON CONFLICT (round_id) DO NOTHING;

  SELECT crash_multiplier INTO _crash
  FROM public.game_crash_rounds
  WHERE round_id = _round_id;

  RETURN _crash;
END;
$$;

GRANT EXECUTE ON FUNCTION public.game_crash_round_result(bigint) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.game_crash_history(_limit int DEFAULT 12)
RETURNS TABLE (round_id bigint, crash_multiplier numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.round_id, r.crash_multiplier
  FROM public.game_crash_rounds r
  ORDER BY r.round_id DESC
  LIMIT LEAST(GREATEST(_limit, 1), 50)
$$;

GRANT EXECUTE ON FUNCTION public.game_crash_history(int) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.game_crash_players(_round bigint, _limit int DEFAULT 8, _exclude bigint DEFAULT NULL)
RETURNS TABLE (name text, photo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(NULLIF(btrim(p.first_name), ''), NULLIF(btrim(p.username), ''), 'Player') AS name,
    p.photo_url
  FROM public.profiles p
  WHERE p.telegram_id IS NOT NULL
    AND (_exclude IS NULL OR p.telegram_id <> _exclude)
    AND COALESCE(p.is_banned, false) = false
    AND NULLIF(btrim(p.photo_url), '') IS NOT NULL
  ORDER BY md5(p.telegram_id::text || '-' || _round::text)
  LIMIT LEAST(GREATEST(_limit, 1), 20)
$$;

GRANT EXECUTE ON FUNCTION public.game_crash_players(bigint, int, bigint) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.game_crash_start(_telegram_id bigint, _stake numeric, _round_id bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bal numeric;
  _bet_id uuid;
  _crash numeric;
  _effective_round bigint;
BEGIN
  IF _stake IS NULL OR _stake <= 0 OR _stake > 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_stake');
  END IF;

  SELECT ton_balance INTO _bal FROM profiles WHERE telegram_id = _telegram_id FOR UPDATE;
  IF _bal IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_profile');
  END IF;
  IF _bal < _stake THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_funds');
  END IF;

  _effective_round := COALESCE(_round_id, floor(extract(epoch FROM now()) / 15)::bigint);
  _crash := public.game_crash_round_result(_effective_round);

  UPDATE profiles SET ton_balance = ton_balance - _stake WHERE telegram_id = _telegram_id;

  INSERT INTO game_bets (telegram_id, game_slug, stake, meta, status)
  VALUES (_telegram_id, 'crash', _stake, jsonb_build_object('crash', _crash, 'round_id', _effective_round), 'open')
  RETURNING id INTO _bet_id;

  SELECT ton_balance INTO _bal FROM profiles WHERE telegram_id = _telegram_id;

  RETURN jsonb_build_object('success', true, 'bet_id', _bet_id, 'balance', _bal, 'round_id', _effective_round);
END;
$$;

GRANT EXECUTE ON FUNCTION public.game_crash_start(bigint, numeric, bigint) TO anon, authenticated, service_role;