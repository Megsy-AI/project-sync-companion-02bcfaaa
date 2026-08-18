import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { useTonConnectUI } from "@tonconnect/ui-react";
import { crashCashout, crashStart, errorText, fmt } from "@/lib/casino";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/hooks/use-toast";
import { PaymentError, sendTonPayment } from "@/lib/ton";
import { verifyTonOnChain } from "@/lib/game-api";


/** Multiplier curve — must match the server-side validation (1.07^seconds). */
const curve = (seconds: number) => Math.pow(1.07, seconds);
const secondsFor = (mult: number) => Math.log(mult) / Math.log(1.07);

type Phase = "betting" | "flying" | "crashed";

const BETTING_MS = 6000;
const CRASHED_MS = 3200;
const QUICK = [0.1, 0.5, 1, 5];

/** Client-side visual bust point; the server always has the final word on payouts. */
const randomBust = () => Math.min(25, Math.max(1.05, 0.96 / (1 - Math.random())));

/** Static starfield (generated once so stars never jump between renders). */
const STARS = Array.from({ length: 70 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
  return {
    x: r(1) * 100,
    y: r(2) * 100,
    size: 0.5 + r(3) * 1.4,
    opacity: 0.15 + r(4) * 0.45,
    delay: r(5) * 4,
    dur: 2.4 + r(6) * 3.6,
  };
});

const chipTone = (m: number) =>
  m >= 10
    ? "text-[hsl(var(--aviator-glow))] border-[hsl(var(--aviator)/0.5)] bg-[hsl(var(--aviator)/0.12)]"
    : m >= 2
      ? "text-primary border-primary/40 bg-primary/10"
      : "text-white/80 border-white/20 bg-white/[0.07]";

const NAMES = ["a***i", "m***o", "s***a", "k***l", "n***r", "d***z", "y***i", "o***r", "l***a", "r***a"];

const AviatorGame = () => {
  const { user, refreshProfile } = useApp();
  const { toast } = useToast();
  const [tonConnectUI] = useTonConnectUI();
  const balance = Number(user.tonBalance || 0);

  const [topping, setTopping] = useState(false);
  const [stake, setStake] = useState(0.5);

  const [phase, setPhase] = useState<Phase>("betting");
  const [countdown, setCountdown] = useState(BETTING_MS);
  const [queued, setQueued] = useState<number | null>(null);
  const [betId, setBetId] = useState<string | null>(null);
  const [mult, setMult] = useState(1);
  const [crashAt, setCrashAt] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [history, setHistory] = useState<number[]>([2.31, 1.14, 5.72, 1.02, 3.4, 1.63]);
  const [busy, setBusy] = useState(false);
  const [players, setPlayers] = useState<{ name: string; bet: number; out?: number }[]>([]);

  const startedAt = useRef(0);
  const bust = useRef(2);
  const probed = useRef(false);
  const raf = useRef<number>();
  const cashedRef = useRef(false);

  const rollPlayers = () =>
    setPlayers(
      Array.from({ length: 6 }, () => ({
        name: NAMES[Math.floor(Math.random() * NAMES.length)],
        bet: Number((Math.random() * 4 + 0.2).toFixed(2)),
      })),
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
        ps.map((p) => (Math.random() > 0.55 ? { ...p, out: Number((1 + Math.random() * (at - 1)).toFixed(2)) } : p)),
      );
      if (!cashedRef.current && queued) setResult(`Flew away at ×${at.toFixed(2)} · −${fmt(queued)} Gram`);
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
      rollPlayers();
      const started = Date.now();
      const id = setInterval(() => {
        const left = BETTING_MS - (Date.now() - started);
        setCountdown(Math.max(0, left));
        if (left <= 0) {
          clearInterval(id);
          void takeOff();
        }
      }, 80);
      return () => clearInterval(id);
    }
    if (phase === "crashed") {
      const id = setTimeout(() => {
        setPhase("betting");
        setMult(1);
        setCrashAt(null);
      }, CRASHED_MS);
      return () => clearTimeout(id);
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
      const res: any = await crashStart(user.telegramUser.id, queued, Date.now());
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
      setResult(`Opening a ${fmt(amountTon)} Gram top-up…`);
      const tx = await sendTonPayment(tonConnectUI, {
        amountTon,
        telegramId: user.telegramUser.id,
        action: "deposit",
        metadata: { source: "aviator" },
      });
      const verification = await verifyTonOnChain(tx.intentId, tx.boc, tonConnectUI.account?.address);
      await refreshProfile();
      if (!verification.verified) {
        setResult("Top-up sent — it will be credited shortly.");
        return false;
      }
      setResult(`Topped up ${fmt(tx.amountTon)} Gram`);
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

  const placeBet = async () => {
    if (!Number.isFinite(stake) || stake <= 0) return;
    if (stake > balance) {
      const shortfall = Math.max(0.1, Math.ceil((stake - balance) * 100) / 100);
      const ok = await topUp(shortfall);
      if (!ok) return;
      setQueued(stake);
      return;
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
      setResult(`Cashed out ×${res.multiplier} · +${fmt(res.payout)} Gram`);
      setQueued(null);
    } else {
      cashedRef.current = false;
      bust.current = Number(res?.crash || at);
      probed.current = true;
    }
    await refreshProfile();
    setBusy(false);
  };

  const progress = Math.min(1, secondsFor(mult) / secondsFor(14));
  const px = 8 + 78 * progress;
  const py = 12 + 70 * progress;
  const flying = phase === "flying";
  const step = (d: number) => setStake((s) => Math.max(0.1, Number((s + d).toFixed(2))));

  return (
    <div className="space-y-2.5">
      {/* Recent rounds */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {history.map((h, i) => (
          <span key={`${h}-${i}`} className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${chipTone(h)}`}>
            {h.toFixed(2)}x
          </span>
        ))}
      </div>

      {/* Space */}
      <div
        className="relative h-[34dvh] max-h-[300px] min-h-[210px] overflow-hidden rounded-[26px] border border-white/[0.08]"

        style={{
          background:
            "radial-gradient(120% 100% at 50% 0%, rgba(60,180,220,0.10), transparent 60%), linear-gradient(180deg, hsl(var(--aviator-sky)) 0%, #05070f 100%)",
        }}
      >
        {/* starfield */}
        <div className="absolute inset-0">
          {STARS.map((s, i) => (
            <motion.span
              key={i}
              className="absolute rounded-full bg-white"
              style={{
                left: `${s.x}%`,
                top: `${s.y}%`,
                width: s.size,
                height: s.size,
                boxShadow: s.size > 1.3 ? "0 0 5px rgba(255,255,255,0.6)" : undefined,
              }}
              animate={{ opacity: [s.opacity * 0.35, s.opacity, s.opacity * 0.35] }}
              transition={{ duration: s.dur, delay: s.delay, repeat: Infinity, ease: "easeInOut" }}
            />
          ))}
        </div>

        {/* horizon line */}
        <div className="absolute inset-x-0 bottom-0 h-12 border-t border-white/[0.06]" />

        {/* curve */}
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="av-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--aviator))" stopOpacity="0.35" />
              <stop offset="100%" stopColor="hsl(var(--aviator))" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="av-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="hsl(var(--aviator))" />
              <stop offset="100%" stopColor="hsl(var(--aviator-glow))" />
            </linearGradient>
          </defs>
          <path d={`M8,90 Q${8 + (px - 8) * 0.66},${90 - (78 - py) * 0.1} ${px},${100 - py} L${px},90 Z`} fill="url(#av-fill)" />
          <path
            d={`M8,90 Q${8 + (px - 8) * 0.66},${90 - (78 - py) * 0.1} ${px},${100 - py}`}
            fill="none"
            stroke="url(#av-line)"
            strokeWidth="1.6"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* moving dot */}
        <motion.div
          className="absolute z-10"
          style={{ left: `${px}%`, bottom: `${py}%` }}
          animate={
            phase === "crashed"
              ? { scale: 0, opacity: 0 }
              : { scale: 1, opacity: phase === "betting" ? 0.35 : 1 }
          }
          transition={{ duration: phase === "crashed" ? 0.45 : 0.2, ease: "easeOut" }}
        >
          <div className="relative flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center">
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: "hsl(var(--aviator-glow))",
                boxShadow: "0 0 20px 6px hsl(var(--aviator) / 0.55), 0 0 40px 12px hsl(var(--aviator) / 0.25)",
              }}
            />
            <span className="relative h-2 w-2 rounded-full bg-white" />
          </div>
        </motion.div>

        {/* readout */}
        <div className="absolute inset-x-0 top-[42%] -translate-y-1/2 text-center">
          <AnimatePresence mode="wait">
            {phase === "betting" ? (
              <motion.div key="wait" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/80">Next round in</p>
                <p className="mt-2 font-display text-[40px] leading-none text-foreground">{(countdown / 1000).toFixed(1)}</p>
                <div className="mx-auto mt-3 h-[3px] w-32 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full transition-[width] duration-75"
                    style={{ width: `${(countdown / BETTING_MS) * 100}%`, background: "hsl(var(--aviator))" }}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div key="mult" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                <p
                  className="font-display text-[46px] leading-none tabular-nums"
                  style={{
                    color: phase === "crashed" ? "hsl(var(--aviator-glow))" : "hsl(0 0% 100%)",
                    textShadow: "0 0 40px hsl(var(--aviator) / 0.4)",
                  }}
                >
                  {(crashAt ?? mult).toFixed(2)}x
                </p>
                {phase === "crashed" && (
                  <p className="mt-2 text-[11px] uppercase tracking-[0.38em]" style={{ color: "hsl(var(--aviator-glow))" }}>
                    Flew away
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {queued !== null && (
          <span
            className="absolute left-4 top-4 rounded-full px-3 py-1.5 text-[11px] font-semibold text-foreground"
            style={{ background: "hsl(var(--aviator) / 0.14)", border: "1px solid hsl(var(--aviator) / 0.4)" }}
          >
            {fmt(queued)} Gram in play
          </span>
        )}
        <span className="absolute right-4 top-4 text-[12px] font-semibold text-white/80">Balance {fmt(balance)}</span>
      </div>

      {result && <p className="text-center text-[13px] font-medium text-white/85">{result}</p>}

      {/* Bet panel */}
      <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.035] p-2.5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="flex h-12 items-center justify-between rounded-2xl border border-white/[0.10] bg-black/30 px-2">
              <button
                type="button"
                onClick={() => step(-0.1)}
                aria-label="Decrease bet"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.07] text-foreground"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="font-display text-[18px] tabular-nums text-foreground">{stake.toFixed(2)}</span>
              <button
                type="button"
                onClick={() => step(0.1)}
                aria-label="Increase bet"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.07] text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setStake(q)}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.03] py-1.5 text-[12px] font-semibold text-white/85"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {flying && betId ? (
            <button
              type="button"
              onClick={() => void cashout()}
              disabled={busy}
              className="flex h-[74px] w-[42%] flex-col items-center justify-center rounded-2xl text-primary-foreground disabled:opacity-60"
              style={{ background: "linear-gradient(180deg, hsl(var(--primary)), hsl(158 78% 30%))" }}
            >
              <span className="text-[11px] uppercase tracking-[0.2em] opacity-80">Cash out</span>
              <span className="font-display text-[20px] tabular-nums">{fmt((queued ?? 0) * mult)}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void placeBet()}
              disabled={queued !== null || phase !== "betting" || topping}
              className="flex h-[74px] w-[42%] flex-col items-center justify-center rounded-2xl text-white disabled:opacity-45"
              style={{ background: "linear-gradient(180deg, hsl(var(--aviator-glow)), hsl(var(--aviator)))" }}
            >
              <span className="text-[11px] uppercase tracking-[0.2em] opacity-90">
                {topping ? "Top up" : queued !== null ? "Waiting" : stake > balance ? "Add Gram" : "Bet"}
              </span>
              <span className="font-display text-[20px] tabular-nums">{stake.toFixed(2)}</span>
            </button>

          )}
        </div>
      </div>

      {/* Live bets */}
      <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.035] p-3">
        <div className="mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">
          <span>Player</span>
          <span>Bet</span>
          <span>Cash out</span>
        </div>
        <div className="space-y-1.5">
          {players.map((p, i) => (
            <div
              key={`${p.name}-${i}`}
              className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px]"
            >
              <span className="w-1/3 text-white/75">{p.name}</span>
              <span className="w-1/3 text-center tabular-nums text-foreground">{fmt(p.bet)}</span>
              <span className={`w-1/3 text-right tabular-nums ${p.out ? "text-primary" : "text-muted-foreground"}`}>
                {p.out ? `${p.out.toFixed(2)}x` : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AviatorGame;
