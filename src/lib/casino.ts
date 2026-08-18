import { supabase } from "@/integrations/supabase/client";

export type CasinoGame = "slots" | "dice" | "coinflip" | "roulette" | "wheel";

export interface RoundResult {
  success: boolean;
  error?: string;
  multiplier?: number;
  payout?: number;
  outcome?: Record<string, unknown>;
  balance?: number;
}

/** Plays one instant round server-side: stake is debited and winnings credited atomically. */
export const playRound = async (
  telegramId: number,
  game: CasinoGame,
  stake: number,
  params: Record<string, unknown> = {},
): Promise<RoundResult> => {
  const { data, error } = await (supabase as any).rpc("game_play_round", {
    _telegram_id: telegramId,
    _game_slug: game,
    _stake: stake,
    _params: params,
  });
  if (error) return { success: false, error: error.message };
  return (data ?? { success: false, error: "unknown" }) as RoundResult;
};

export const crashStart = async (telegramId: number, stake: number, roundId: number) => {
  const { data, error } = await (supabase as any).rpc("game_crash_start", {
    _telegram_id: telegramId,
    _stake: stake,
    _round_id: roundId,
  });
  if (error) return { success: false, error: error.message } as any;
  return data as { success: boolean; bet_id?: string; error?: string; balance?: number };
};

export const crashCashout = async (telegramId: number, betId: string, at: number) => {
  const { data, error } = await (supabase as any).rpc("game_crash_cashout", {
    _telegram_id: telegramId,
    _bet_id: betId,
    _at: at,
  });
  if (error) return { success: false, error: error.message } as any;
  return data as { success: boolean; multiplier?: number; payout?: number; crash?: number };
};

export const errorText = (code?: string) => {
  switch (code) {
    case "insufficient_funds":
      return "Not enough Gram";
    case "invalid_stake":
      return "Stake must be between 0 and 100";
    case "no_profile":
      return "Profile not ready yet";
    default:
      return "Please try again";
  }
};

export const fmt = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 0 });
