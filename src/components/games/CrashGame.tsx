import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Gift, Minus, Plus } from "lucide-react";
import { useTonConnectUI } from "@tonconnect/ui-react";
import { crashCashout, crashStart, errorText, fmt } from "@/lib/casino";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/hooks/use-toast";
import { PaymentError, sendTonPayment } from "@/lib/ton";
import { verifyTonOnChain } from "@/lib/game-api";

/** Multiplier curve — must match the server-side validation (1.07^seconds). */
const curve = (seconds: number) => Math.pow(1.07, seconds);

type Phase = "betting" | "flying" | "crashed";

const BETTING_MS = 6000;
const CRASHED_MS = 3600;

/** Client-side visual bust point; the server always has the final word on payouts. */
const randomBust = () => Math.min(25, Math.max(1.05, 0.96 / (1 - Math.random())));

const STARS = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
  return { x: r(1) * 100, y: r(2) * 100, size: 0.6 + r(3) * 1.6, delay: r(4) * 4, dur: 2.6 + r(5) * 3.4 };
});

const NAMES = ["Young Eagle", "Cheerful Falcon", "Fierce Sparrow", "Lucky Badger", "Curious Jaguar", "Silent Otter"];
const AVATARS = ["160 60% 45%", "258 60% 30%", "330 60% 45%", "24 85% 60%", "200 70% 50%", "280 60% 55%"];

const chipTone = (m: number) =>
  m >= 10
    ? "bg-[hsl(var(--crash-gold))] text-[hsl(var(--crash-bg))]"
    : "bg-[hsl(var(--crash-accent))] text-primary-foreground";

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
  const [history, setHistory] = useState<number[]>([2.21, 2.25, 2.04, 17.79, 1.32]);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(280274);
  const [players, setPlayers] = useState<{ name: string; bet: number; tone: string; out?: number }[]>([]);

  const startedAt = useRef(0);
  const bust = useRef(2);
  const probed = useRef(false);
  const raf = useRef<number>();
  const cashedRef = useRef(false);

  const rollPlayers = () =>
    setPlayers(
      NAMES.map((name, i) => ({
        name,
        tone: AVATARS[i],
        bet: Number((Math.random() * 40 + 12).toFixed(2)),
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
        setRound((r) => r + 1);
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

  /** Telegram gifts bet — opens the gift bot so the player can send a gift as a stake. */
  const betWithGift = () => {
    const tg = (window as any).Telegram?.WebApp;
    const link = "https://t.me/Noveaibot/App";
    if (tg?.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, "_blank");
    toast({ title: "Gift bet", description: "Send your Telegram gift — it is credited as a stake automatically." });
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
      className="min-h-screen pb-48"
      style={{
        background:
          "radial-gradient(120% 70% at 50% 0%, hsl(var(--crash-surface) / 0.55), transparent 60%), linear-gradient(180deg, hsl(var(--crash-bg)) 0%, hsl(258 60% 5%) 100%)",
      }}
    >
      {/* Header */}
      <div className="px-5 pt-5">
        <h1 className="font-display text-[42px] leading-none tracking-tight text-foreground">Crash</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Test your luck and claim all gifts! <span className="font-semibold text-foreground">How to play</span>
        </p>
      </div>

      {/* Stage */}
      <div className="relative mt-2 h-[42dvh] max-h-[360px] min-h-[260px] overflow-hidden">
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
                animate={{ scale: [1.1, 1], opacity: 1, rotate: [6, -4, 0] }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: 0.5 }}
              />
            ) : flying ? (
              <motion.img
                key="fly"
                src="/images/duck-fly.webp"
                alt="Duck flying"
                className="h-[180px] w-[180px] object-contain"
                initial={{ opacity: 0, y: 40, scale: 0.85 }}
                animate={{ opacity: 1, y: [0, -14, 0], scale: 1, rotate: [-3, 3, -3] }}
                exit={{ opacity: 0, y: -80, scale: 0.6 }}
                transition={{ y: { duration: 2, repeat: Infinity, ease: "easeInOut" }, rotate: { duration: 3, repeat: Infinity }, opacity: { duration: 0.3 } }}
              />
            ) : (
              <motion.img
                key="idle"
                src="/images/duck-idle.webp"
                alt="Duck waiting"
                className="h-[170px] w-[170px] object-contain"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: [1, 1.04, 1] }}
                exit={{ opacity: 0 }}
                transition={{ scale: { duration: 2.4, repeat: Infinity } }}
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

        <span className="absolute right-5 top-3 text-[12px] font-semibold text-muted-foreground">
          Balance {fmt(balance)}
        </span>
        {queued !== null && (
          <span className="absolute left-5 top-3 rounded-full bg-[hsl(var(--crash-accent)/0.2)] px-3 py-1 text-[11px] font-semibold text-foreground">
            {fmt(queued)} in play
          </span>
        )}
      </div>

      {/* Recent multipliers */}
      <div className="mt-1 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {history.map((h, i) => (
          <span
            key={`${h}-${i}`}
            className={`shrink-0 rounded-full px-6 py-3 font-display text-[17px] ${
              i === 0 ? "bg-foreground text-[hsl(var(--crash-bg))]" : chipTone(h)
            }`}
          >
            x{h.toFixed(2)}
          </span>
        ))}
      </div>

      {result && <p className="px-5 pt-2 text-center text-[13px] font-medium text-foreground">{result}</p>}

      {/* Players */}
      <div className="mx-4 mt-3 overflow-hidden rounded-[28px] bg-[hsl(var(--crash-surface)/0.55)] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[15px] text-muted-foreground">{players.length} Players</span>
          <span className="font-display text-[17px] text-[hsl(var(--crash-accent-soft))]">Game #{round}</span>
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl">
          {players.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-3 border-b border-foreground/[0.06] bg-[hsl(var(--crash-accent)/0.14)] px-3 py-2.5 last:border-0"
            >
              <span
                className="h-9 w-9 shrink-0 rounded-full"
                style={{ background: `hsl(${p.tone})` }}
              />
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

      {/* Stake stepper */}
      <div className="mx-4 mt-3 flex items-center justify-between rounded-full bg-[hsl(var(--crash-surface)/0.5)] px-2 py-2">
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

      {/* Bottom actions */}
      <div className="fixed inset-x-0 bottom-[76px] z-30 flex gap-3 px-4">
        {flying && betId ? (
          <button
            type="button"
            onClick={() => void cashout()}
            disabled={busy}
            className="h-14 flex-1 rounded-full bg-[hsl(var(--crash-gold))] font-display text-[18px] text-[hsl(var(--crash-bg))] disabled:opacity-60"
          >
            Cash out x{mult.toFixed(2)}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void betWithTon()}
              disabled={topping || queued !== null}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-foreground font-display text-[18px] text-[hsl(var(--crash-bg))] disabled:opacity-60"
            >
              <img src="/images/ton-icon.jpg" alt="" className="h-6 w-6 rounded-full object-cover" />
              {topping ? "..." : queued !== null ? "Bet placed" : "Bet with TON"}
            </button>
            <button
              type="button"
              onClick={betWithGift}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-[hsl(var(--crash-accent))] font-display text-[18px] text-primary-foreground"
            >
              <Gift className="h-5 w-5" />
              Bet with Gift
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default CrashGame;
