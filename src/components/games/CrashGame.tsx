import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { useTonConnectUI } from "@tonconnect/ui-react";
import { crashCashout, crashStart, errorText, fmt } from "@/lib/casino";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/hooks/use-toast";
import { PaymentError, sendTonPayment } from "@/lib/ton";
import { verifyTonOnChain } from "@/lib/game-api";

/** Multiplier curve — must match the server-side validation (1.07^seconds). */
const curve = (seconds: number) => Math.pow(1.07, seconds);

type Phase = "betting" | "flying" | "crashed";

const BETTING_MS = 6000;
const CRASHED_MS = 3600;

/** Every client derives the same global round id from the wall clock. */
const ROUND_EPOCH = Date.UTC(2026, 0, 1) / 1000;
const ROUND_LENGTH = 15; // seconds per round cycle
const roundId = () => Math.floor((Date.now() / 1000 - ROUND_EPOCH) / ROUND_LENGTH);

const STARS = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
  return { x: r(1) * 100, y: r(2) * 100, size: 0.6 + r(3) * 1.6, delay: r(4) * 4, dur: 2.6 + r(5) * 3.4 };
});

const TONES = ["160 60% 45%", "258 60% 40%", "330 60% 45%", "24 85% 60%", "200 70% 50%", "280 60% 55%"];

interface Player {
  key: string;
  name: string;
  photo: string | null;
  tone: string;
  bet: number;
  out?: number;
}

const chipTone = (m: number) =>
  m >= 10
    ? "bg-[hsl(var(--crash-gold))] text-[hsl(var(--crash-bg))]"
    : "bg-[hsl(var(--crash-accent))] text-primary-foreground";

/** Smoothly counting bet amount that pops as it grows with the multiplier. */
const LiveAmount = ({ value, live }: { value: number; live: boolean }) => {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 120, damping: 20, mass: 0.4 });
  const text = useTransform(spring, (v) => v.toFixed(2));

  useEffect(() => {
    mv.set(value);
  }, [value, mv]);

  return (
    <motion.span
      className="block text-[15px] tabular-nums"
      animate={
        live
          ? { scale: [1, 1.08, 1], color: "hsl(var(--crash-gold))" }
          : { scale: 1, color: "hsl(var(--foreground))" }
      }
      transition={{ scale: { duration: 0.5, repeat: live ? Infinity : 0, ease: "easeInOut" }, color: { duration: 0.3 } }}
    >
      {text}
    </motion.span>
  );
};


const CrashGame = () => {
  const { user, refreshProfile } = useApp();
  const { toast } = useToast();
  const [tonConnectUI] = useTonConnectUI();
  const balance = Number(user.tonBalance || 0);

  const [stake, setStake] = useState(0.5);
  const [topping, setTopping] = useState(false);
  const [phase, setPhase] = useState<Phase>("betting");
  const [countdown, setCountdown] = useState(BETTING_MS);
  const [queued, setQueued] = useState<number | null>(null);
  const [betId, setBetId] = useState<string | null>(null);
  const [mult, setMult] = useState(1);
  const [crashAt, setCrashAt] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(roundId);
  const [players, setPlayers] = useState<Player[]>([]);
  const [playerCount, setPlayerCount] = useState(40);

  const startedAt = useRef(0);
  const bust = useRef(2);
  const probed = useRef(false);
  const raf = useRef<number>();
  const cashedRef = useRef(false);

  /** Real usernames + avatars pulled from the database, deduplicated per round. */
  const rollPlayers = useCallback(
    async (forRound: number) => {
      // 40 → 120 players per round (deterministic per round so everyone sees the same lobby)
      const target = 40 + (Math.abs(Math.sin(forRound) * 10000) % 81 | 0);
      const { data } = await (supabase as any).rpc("game_crash_players", {
        _round: forRound,
        _limit: target,
        _exclude: user.telegramUser.id,
      });
      const rows: { name: string; photo_url: string | null }[] = Array.isArray(data) ? data : [];
      const seenName = new Set<string>();
      const seenPhoto = new Set<string>();
      const unique: Player[] = [];
      rows.forEach((r, i) => {
        const name = (r.name || "Player").trim();
        const photo = r.photo_url?.trim() || null;
        if (!photo) return;
        if (seenName.has(name.toLowerCase())) return;
        if (photo && seenPhoto.has(photo)) return;
        seenName.add(name.toLowerCase());
        if (photo) seenPhoto.add(photo);
        unique.push({
          key: `${forRound}-${name}-${i}`,
          name,
          photo,
          tone: TONES[i % TONES.length],
          bet: Number((Math.random() * 8 + 0.2).toFixed(2)),
        });
      });
      setPlayers(unique);
      setPlayerCount(Math.max(unique.length, target));
    },
    [user.telegramUser.id],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await (supabase as any).rpc("game_crash_history", { _limit: 12 });
      if (!active || !Array.isArray(data)) return;
      setHistory(
        data
          .map((item: { crash_multiplier: number | string }) => Number(item.crash_multiplier))
          .filter(Number.isFinite),
      );
    })();
    return () => {
      active = false;
    };
  }, []);

  const probe = useCallback(
    async (id: string) => {
      const res: any = await crashCashout(user.telegramUser.id, id, 1e6);
      const serverCrash = Number(res?.crash || 0);
      setBetId(null);
      await refreshProfile();
      return serverCrash > 1 ? serverCrash : bust.current;
    },
    [refreshProfile, user.telegramUser.id],
  );

  const endRound = useCallback(
    (at: number) => {
      setPhase("crashed");
      setCrashAt(at);
      setMult(at);
      setHistory((h) => [Number(at.toFixed(2)), ...h].slice(0, 12));
      setPlayers((ps) =>
        ps.map((p) => (Math.random() > 0.5 ? { ...p, out: Number((1 + Math.random() * (at - 1)).toFixed(2)) } : p)),
      );
      if (!cashedRef.current && queued) setResult(`Crashed at x${at.toFixed(2)} — ${fmt(queued)} Gram lost`);
      setQueued(null);
    },
    [queued],
  );

  useEffect(() => {
    if (phase !== "flying") return;
    let cancelled = false;
    const tick = async () => {
      const m = curve((Date.now() - startedAt.current) / 1000);
      setMult(m);
      if (m >= bust.current && !probed.current) {
        probed.current = true;
        if (betId && !cashedRef.current) {
          const real = await probe(betId);
          if (cancelled) return;
          bust.current = Math.max(real, m);
          if (m >= bust.current) return endRound(bust.current);
        } else {
          return endRound(bust.current);
        }
      }
      if (probed.current && m >= bust.current) return endRound(bust.current);
      raf.current = requestAnimationFrame(() => void tick());
    };
    raf.current = requestAnimationFrame(() => void tick());
    return () => {
      cancelled = true;
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [phase, betId, probe, endRound]);

  useEffect(() => {
    if (phase === "betting") {
      const id = roundId();
      setRound(id);
      void rollPlayers(id);
      const started = Date.now();
      const timer = setInterval(() => {
        const left = BETTING_MS - (Date.now() - started);
        setCountdown(Math.max(0, left));
        if (left <= 0) {
          clearInterval(timer);
          void takeOff();
        }
      }, 80);
      return () => clearInterval(timer);
    }
    if (phase === "crashed") {
      const timer = setTimeout(() => {
        setPhase("betting");
        setMult(1);
        setCrashAt(null);
      }, CRASHED_MS);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const takeOff = async () => {
    const activeRound = round;
    const { data: savedBust } = await (supabase as any).rpc("game_crash_round_result", { _round_id: activeRound });
    bust.current = Number(savedBust) > 0 ? Number(savedBust) : 1;
    probed.current = false;
    cashedRef.current = false;
    startedAt.current = Date.now();
    setMult(1);
    if (queued) {
      const res: any = await crashStart(user.telegramUser.id, queued, activeRound);
      if (!res?.success) {
        toast({ title: "Bet failed", description: errorText(res?.error), variant: "destructive" });
        setQueued(null);
      } else {
        setBetId(res.bet_id as string);
        startedAt.current = Date.now();
        await refreshProfile();
      }
    }
    setPhase("flying");
  };

  /** Not enough Gram? Open a TON top-up for the shortfall instead of blocking the bet. */
  const topUp = async (amountTon: number) => {
    setTopping(true);
    try {
      setResult(`Opening a ${fmt(amountTon)} TON top-up...`);
      const tx = await sendTonPayment(tonConnectUI, {
        amountTon,
        telegramId: user.telegramUser.id,
        action: "deposit",
        metadata: { source: "crash" },
      });
      const verification = await verifyTonOnChain(tx.intentId, tx.boc, tonConnectUI.account?.address);
      await refreshProfile();
      if (!verification.verified) {
        setResult("Top-up sent — it will be credited shortly.");
        return false;
      }
      setResult(`Topped up ${fmt(tx.amountTon)}`);
      return true;
    } catch (err) {
      const msg = err instanceof PaymentError ? err.message : "Top-up failed. Please try again.";
      toast({ title: "Top-up", description: msg, variant: "destructive" });
      setResult(null);
      return false;
    } finally {
      setTopping(false);
    }
  };

  const betWithTon = async () => {
    if (!Number.isFinite(stake) || stake <= 0) return;
    if (stake > balance) {
      const shortfall = Math.max(0.1, Math.ceil((stake - balance) * 100) / 100);
      const ok = await topUp(shortfall);
      if (!ok) return;
    }
    setResult(null);
    setQueued(stake);
  };

  const cashout = async () => {
    if (!betId) return;
    setBusy(true);
    cashedRef.current = true;
    const at = Number(curve((Date.now() - startedAt.current) / 1000).toFixed(2));
    const res: any = await crashCashout(user.telegramUser.id, betId, at);
    setBetId(null);
    if (Number(res?.payout) > 0) {
      setResult(`Cashed out x${res.multiplier} · +${fmt(res.payout)} Gram`);
      setQueued(null);
    } else {
      cashedRef.current = false;
      bust.current = Number(res?.crash || at);
      probed.current = true;
    }
    await refreshProfile();
    setBusy(false);
  };

  const flying = phase === "flying";
  const step = (d: number) => setStake((s) => Math.max(0.1, Number((s + d).toFixed(2))));

  return (
    <div className="min-h-screen bg-transparent pb-28">
      {/* Balance only */}
      <div className="flex items-center justify-end px-4 pt-4">
        <span className="flex items-center gap-2 rounded-full bg-foreground/10 px-4 py-2 text-[14px] font-semibold text-foreground">
          <img src="/images/ton-icon.jpg" alt="" className="h-5 w-5 rounded-full object-cover" />
          {fmt(balance)}
        </span>
      </div>

      {/* Stage */}
      <div className="relative mt-1 h-[38dvh] max-h-[330px] min-h-[240px] overflow-hidden">
        {STARS.map((s, i) => (
          <motion.span
            key={i}
            className="absolute rounded-full bg-foreground"
            style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size }}
            animate={{ opacity: [0.1, 0.5, 0.1] }}
            transition={{ duration: s.dur, delay: s.delay, repeat: Infinity, ease: "easeInOut" }}
          />
        ))}

        <div className="pointer-events-none absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={phase === "crashed" ? "crash" : phase === "betting" ? "idle" : "plane"}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {phase === "crashed" ? (
                <img
                  src={`/images/duck-crash.gif?round=${round}`}
                  alt="Duck exploded"
                  width={360}
                  height={360}
                  className="h-[210px] w-[210px] object-contain drop-shadow-[0_10px_45px_hsl(var(--crash-danger)/0.55)]"
                />
              ) : phase === "betting" ? (
                <img
                  src={`/images/duck-wait.gif?round=${round}`}
                  alt="Duck waiting for the next game"
                  width={360}
                  height={360}
                  className="h-[190px] w-[190px] object-contain"
                />
              ) : (
                <img
                  src={`/images/duck-plane.gif?round=${round}`}
                  alt="Duck flying a plane"
                  width={360}
                  height={360}
                  className="h-[210px] w-[210px] object-contain drop-shadow-[0_18px_40px_hsl(var(--crash-accent)/0.5)]"
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>


        {/* Readout */}
        <div className="absolute inset-x-0 bottom-0 text-center">
          {phase === "betting" ? (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">Next round in</p>
              <p className="mt-1 font-display text-[34px] leading-none text-foreground">{(countdown / 1000).toFixed(1)}</p>
            </>
          ) : (
            <p
              className="font-display text-[44px] leading-none tabular-nums"
              style={{
                color: phase === "crashed" ? "hsl(var(--crash-danger))" : "hsl(var(--foreground))",
                textShadow: "0 0 40px hsl(var(--crash-accent) / 0.5)",
              }}
            >
              {(crashAt ?? mult).toFixed(2)}x
            </p>
          )}
        </div>

        {queued !== null && (
          <span className="absolute left-5 top-1 rounded-full bg-[hsl(var(--crash-accent)/0.2)] px-3 py-1 text-[11px] font-semibold text-foreground">
            {fmt(queued)} in play
          </span>
        )}
      </div>

      {/* Recent multipliers — compact chips */}
      {history.length > 0 && (
        <div className="mt-1 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {history.map((h, i) => (
            <span
              key={`${h}-${i}`}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                i === 0 ? "bg-foreground text-[hsl(var(--crash-bg))]" : chipTone(h)
              }`}
            >
              x{h.toFixed(2)}
            </span>
          ))}
        </div>
      )}

      {result && <p className="px-5 pt-2 text-center text-[13px] font-medium text-foreground">{result}</p>}

      {/* Bet controls — above the players list */}
      <div className="mx-4 mt-3 space-y-2">
        <div className="flex items-center justify-between rounded-full bg-[hsl(var(--crash-surface)/0.5)] px-2 py-2">
          <button
            type="button"
            onClick={() => step(-0.1)}
            aria-label="Decrease bet"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/10 text-foreground"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="font-display text-[20px] text-foreground">{stake.toFixed(2)}</span>
          <button
            type="button"
            onClick={() => step(0.1)}
            aria-label="Increase bet"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/10 text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {flying && betId ? (
          <button
            type="button"
            onClick={() => void cashout()}
            disabled={busy}
            className="h-14 w-full rounded-full bg-[hsl(var(--crash-gold))] font-display text-[18px] text-[hsl(var(--crash-bg))] disabled:opacity-60"
          >
            Cash out x{mult.toFixed(2)}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void betWithTon()}
            disabled={topping || queued !== null}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-foreground font-display text-[18px] text-[hsl(var(--crash-bg))] disabled:opacity-60"
          >
            <img src="/images/ton-icon.jpg" alt="" className="h-6 w-6 rounded-full object-cover" />
            {topping ? "..." : queued !== null ? "Bet placed" : "Bet with TON"}
          </button>
        )}
      </div>

      {/* Players */}
      <div className="mx-4 mt-3 overflow-hidden rounded-[28px] bg-[hsl(var(--crash-surface)/0.55)] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[15px] text-muted-foreground">{playerCount} Players</span>
          <span className="font-display text-[17px] text-[hsl(var(--crash-accent-soft))]">Game #{round}</span>
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl">
          {players.map((p) => (
            <div
              key={p.key}
              className="flex items-center gap-3 border-b border-foreground/[0.06] bg-[hsl(var(--crash-accent)/0.14)] px-3 py-2.5 last:border-0"
            >
              <img src={p.photo || ""} alt={`${p.name} avatar`} loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              <span className="min-w-0 flex-1 truncate text-[15px] text-muted-foreground">{p.name}</span>
              <span className="text-right">
                <span className="mb-0.5 block text-[9px] font-bold uppercase text-[hsl(var(--crash-gold))]">Live</span>
                <LiveAmount value={phase === "betting" ? p.bet : p.bet * (crashAt ?? mult)} live={flying} />
                {p.out && (
                  <span className="block text-[12px] font-semibold text-[hsl(var(--crash-danger))]">x{p.out.toFixed(2)}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CrashGame;
