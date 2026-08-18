import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, Minus, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
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
const currentRound = () => Math.floor(Date.now() / 1000 - ROUND_EPOCH) / ROUND_LENGTH;
const roundId = () => Math.floor(currentRound());

/** Client-side visual bust point; the server always has the final word on payouts. */
const randomBust = () => Math.min(25, Math.max(1.05, 0.96 / (1 - Math.random())));

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

const CrashGame = () => {
  const { user, refreshProfile } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
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

  const startedAt = useRef(0);
  const bust = useRef(2);
  const probed = useRef(false);
  const raf = useRef<number>();
  const cashedRef = useRef(false);

  /** Real usernames + avatars pulled from the database, deduplicated per round. */
  const rollPlayers = useCallback(
    async (forRound: number) => {
      const { data } = await (supabase as any).rpc("game_crash_players", {
        _round: forRound,
        _limit: 4 + (forRound % 5),
        _exclude: user.telegramUser.id,
      });
      const rows: { name: string; photo_url: string | null }[] = Array.isArray(data) ? data : [];
      const seenName = new Set<string>();
      const seenPhoto = new Set<string>();
      const unique: Player[] = [];
      rows.forEach((r, i) => {
        const name = (r.name || "Player").trim();
        const photo = r.photo_url || null;
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
    },
    [user.telegramUser.id],
  );

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
    bust.current = randomBust();
    probed.current = false;
    cashedRef.current = false;
    startedAt.current = Date.now();
    setMult(1);
    if (queued) {
      const res: any = await crashStart(user.telegramUser.id, queued);
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
    <div
      className="min-h-screen pb-10"
      style={{
        background:
          "radial-gradient(120% 70% at 50% 0%, hsl(var(--crash-surface) / 0.55), transparent 60%), linear-gradient(180deg, hsl(var(--crash-bg)) 0%, hsl(258 60% 5%) 100%)",
      }}
    >
      {/* Top bar — back button + balance only */}
      <div className="flex items-center justify-between px-4 pt-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/10 text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
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
          <AnimatePresence mode="wait">
            {phase === "crashed" ? (
              <motion.img
                key="crash"
                src="/images/duck-crash.webp"
                alt="Duck crashed"
                className="h-[190px] w-[190px] object-contain"
                initial={{ scale: 0.6, opacity: 0, rotate: -12 }}
                animate={{ scale: [1.2, 1], opacity: 1, rotate: [10, -8, 4, 0], x: [0, -8, 8, 0] }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: 0.6 }}
              />
            ) : (
              <motion.img
                key="plane"
                src="/images/duck-plane.png"
                alt="Duck flying a plane"
                className="h-[190px] w-[190px] object-contain drop-shadow-[0_18px_40px_hsl(var(--crash-accent)/0.5)]"
                initial={{ opacity: 0, y: 30, scale: 0.9 }}
                animate={
                  flying
                    ? { opacity: 1, scale: 1, y: [0, -18, 0], rotate: [-5, 5, -5] }
                    : { opacity: 1, scale: 1, y: [0, -8, 0], rotate: [-2, 2, -2] }
                }
                exit={{ opacity: 0, y: -90, scale: 0.6 }}
                transition={{
                  y: { duration: flying ? 1.6 : 2.8, repeat: Infinity, ease: "easeInOut" },
                  rotate: { duration: flying ? 2.2 : 4, repeat: Infinity, ease: "easeInOut" },
                  opacity: { duration: 0.3 },
                }}
              />
            )}
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
          <span className="text-[15px] text-muted-foreground">{players.length} Players</span>
          <span className="font-display text-[17px] text-[hsl(var(--crash-accent-soft))]">Game #{round}</span>
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl">
          {players.map((p) => (
            <div
              key={p.key}
              className="flex items-center gap-3 border-b border-foreground/[0.06] bg-[hsl(var(--crash-accent)/0.14)] px-3 py-2.5 last:border-0"
            >
              {p.photo ? (
                <img src={p.photo} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-foreground"
                  style={{ background: `hsl(${p.tone})` }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-[15px] text-muted-foreground">{p.name}</span>
              <span className="text-right">
                <span className="block text-[15px] text-foreground">{p.bet.toFixed(2)}</span>
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
