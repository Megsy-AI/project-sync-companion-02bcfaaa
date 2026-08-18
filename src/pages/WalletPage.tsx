import SpotlightHero from "@/components/hero/SpotlightHero";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useApp } from "@/context/AppContext";
import { useTonConnectUI, useTonAddress } from "@tonconnect/ui-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Power, Lock, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, Copy } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PaymentError, sendTonPayment, TON_FEE_BUFFER } from "@/lib/ton";
import { createTransaction, isWalletVerified, verifyTonOnChain } from "@/lib/game-api";
import { payWithStars, STARS_PRICES, type StarsProductId } from "@/lib/stars";
import TelegramStar from "@/components/TelegramStar";
import { useCoinPrices, formatUsd } from "@/hooks/use-coin-prices";

const NOVA_ICON = "/images/nova-icon.jpg";


const TON_ICON = "/images/gram-icon.png";
const USDT_ICON = "/images/usdt.png";
const VERIFY_AMOUNT = 3;
const NFT_MIN_GRAM = 4;
const STAKE_MIN_GRAM = 15;
const TON_USD = 3.5;
const REQUIRED_ATTACKS = 50;

const STAR_PACKS: { id: StarsProductId; usdt: number }[] = [
  { id: "usdt_5", usdt: 5 },
  { id: "usdt_10", usdt: 10 },
  { id: "usdt_25", usdt: 25 },
];

const WalletPage = () => {
  const { user } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [tonConnectUI] = useTonConnectUI();
  const address = useTonAddress();
  const markets = useCoinPrices();
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawCurrency, setWithdrawCurrency] = useState<"ton" | "usdt">("ton");
  const [depositAmount, setDepositAmount] = useState("");
  const [starBusy, setStarBusy] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState<"nft" | "stake" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [hasServer, setHasServer] = useState(false);
  const [hasNft, setHasNft] = useState(false);
  const [stakedTon, setStakedTon] = useState(0);
  const [attacksBought, setAttacksBought] = useState(0);
  const [hasKill, setHasKill] = useState(false);

  useEffect(() => {
    const check = async () => {
      if (!user.profileId) return;
      const [verified, srvRes, invRes, killRes, nftRes, ownNftRes, stakeRes] = await Promise.all([
        isWalletVerified(user.telegramUser.id),
        supabase.from("user_servers").select("id").eq("user_id", user.profileId).limit(1),
        supabase.from("battle_inventory").select("total_purchased").eq("user_id", user.profileId).eq("category", "attack"),
        supabase.from("attacks").select("id").eq("user_id", user.profileId).eq("is_killing_blow", true).limit(1),
        supabase.from("user_servers").select("id").eq("user_id", user.profileId).gte("ton_paid", NFT_MIN_GRAM).limit(1),
        supabase.from("user_nfts").select("id").eq("telegram_id", user.telegramUser.id).gte("price_ton", NFT_MIN_GRAM).limit(1),
        supabase.from("stakes").select("amount").eq("profile_id", user.profileId).eq("currency", "ton").eq("status", "active"),
      ]);
      setIsVerified(Boolean(verified));
      setHasServer(!!srvRes.data && srvRes.data.length > 0);
      setAttacksBought((invRes.data ?? []).reduce((s, r: any) => s + (r.total_purchased ?? 0), 0));
      setHasKill(!!killRes.data && killRes.data.length > 0);
      setHasNft(((nftRes.data ?? []).length + (ownNftRes.data ?? []).length) > 0);
      setStakedTon((stakeRes.data ?? []).reduce((s, r: any) => s + Number(r.amount ?? 0), 0));
    };
    void check();
  }, [user.profileId, user.telegramUser.id]);

  // Withdrawal gate: verification first, then the remaining requirements.
  const openWithdrawFlow = () => {
    if (!isVerified) {
      setWhyOpen(false);
      setVerifyOpen(true);
      return;
    }
    if (!hasNft) {
      setReqOpen("nft");
      return;
    }
    if (stakedTon < STAKE_MIN_GRAM) {
      setReqOpen("stake");
      return;
    }
    setWithdrawCurrency("ton");
    setWithdrawOpen(true);
  };

  const handleConnectWallet = async () => {
    try { await tonConnectUI.openModal(); } catch {}
  };

  if (!tonConnectUI.connected) {
    return (
      <div className="min-h-screen pb-28">
        <SpotlightHero title="Wallet">
        <div className="px-5 pt-8 pb-10 flex flex-col items-center">
        <motion.div
          className="paper-card w-full max-w-sm overflow-hidden p-6"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h1 className="font-display text-3xl leading-none text-foreground">Connect your wallet</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Link a TON wallet to deposit Gram, withdraw rewards and buy servers straight from your balance.
          </p>

          <div className="mt-5 space-y-2.5">
            {[
              { icon: <ArrowDownToLine className="h-4 w-4" />, label: "Deposit Gram in one tap" },
              { icon: <ArrowUpFromLine className="h-4 w-4" />, label: "Withdraw from 1 Gram" },
              { icon: <ShieldCheck className="h-4 w-4" />, label: "Non-custodial — you keep the keys" },
            ].map((row) => (
              <div key={row.label} className="paper-row flex items-center gap-3 px-3.5 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground">
                  {row.icon}
                </span>
                <span className="text-xs font-medium text-foreground">{row.label}</span>
              </div>
            ))}
          </div>

          <button type="button" onClick={handleConnectWallet} className="btn-ink mt-6 h-12 w-full text-xs font-semibold uppercase tracking-widest">
            Connect TON Wallet
          </button>

        </motion.div>
        </div>
        </SpotlightHero>
      </div>
    );
  }


  const gramPrice = markets["the-open-network"]?.price || TON_USD;
  const balances = [
    { symbol: "$NOVA", balance: user.siriBalance, icon: NOVA_ICON, price: 0, usd: 0 },
    {
      symbol: "Gram",
      balance: user.tonBalance,
      icon: TON_ICON,
      price: gramPrice,
      usd: user.tonBalance * gramPrice,
    },
    {
      symbol: "USDT",
      balance: user.usdtBalance,
      icon: USDT_ICON,
      price: markets["tether"]?.price || 1,
      usd: user.usdtBalance * (markets["tether"]?.price || 1),
    },
    {
      symbol: "DOGS",
      balance: 0,
      icon: markets["dogs-2"]?.image || "",
      price: markets["dogs-2"]?.price || 0,
      usd: 0,
    },
    {
      symbol: "NOT",
      balance: 0,
      icon: markets["notcoin"]?.image || "",
      price: markets["notcoin"]?.price || 0,
      usd: 0,
    },
  ];


  const handleDisconnect = async () => {
    await tonConnectUI.disconnect();
    toast({ title: "Disconnected" });
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount <= 0) { toast({ title: "Invalid Amount", variant: "destructive" }); return; }
    try {
      const tx = await sendTonPayment(tonConnectUI, { amountTon: amount, telegramId: user.telegramUser.id, action: "deposit" });
      const verification = await verifyTonOnChain(tx.intentId, tx.boc, tonConnectUI.account?.address);
      if (!verification.verified) throw new PaymentError("failed", verification.error ?? "Payment is still confirming");
      await createTransaction({ telegramId: user.telegramUser.id, type: "deposit", amount, currency: "ton", walletAddress: address, txHash: verification.tx_hash });
      toast({ title: "Deposit Sent", description: `${amount} Gram submitted` });
      setDepositOpen(false);
      setDepositAmount("");
    } catch (err) {
      if (err instanceof PaymentError) {
        toast({
          title: err.code === "not_connected" ? "Wallet not connected" : "Deposit failed",
          description: err.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Deposit failed", description: "Please try again", variant: "destructive" });
    }
  };

  const handleWithdraw = async () => {
    return await handleWithdrawInner();
  };

  const handleStarsTopUp = async (product: StarsProductId) => {
    setStarBusy(true);
    try {
      const status = await payWithStars(product, user.profileId, user.telegramUser.id);
      if (status === "paid") {
        toast({ title: "Payment received", description: "Your balance has been topped up" });
        setDepositOpen(false);
      } else if (status === "cancelled") {
        toast({ title: "Payment cancelled" });
      } else {
        toast({ title: "Finish the payment in Telegram" });
      }
    } catch (err) {
      toast({
        title: "Stars payment failed",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setStarBusy(false);
    }
  };

  const handleWithdrawInner = async () => {
    const amount = parseFloat(withdrawAmount);
    const min = 1;
    if (!amount || amount < min) {
      toast({ title: `Minimum ${min} ${withdrawCurrency.toUpperCase()}`, variant: "destructive" });
      return;
    }
    await createTransaction({ telegramId: user.telegramUser.id, type: "withdrawal", amount, currency: withdrawCurrency, walletAddress: address });
    toast({ title: "Withdrawal Requested", description: `${amount} ${withdrawCurrency.toUpperCase()} submitted` });
    setWithdrawOpen(false);
    setWithdrawAmount("");
  };


  const handleVerifyWallet = async () => {
    setVerifying(true);
    try {
      const tx = await sendTonPayment(tonConnectUI, {
        amountTon: VERIFY_AMOUNT,
        telegramId: user.telegramUser.id,
        action: "wallet_verification",
      });
      const verification = await verifyTonOnChain(tx.intentId, tx.boc, tonConnectUI.account?.address);
      if (!verification.verified) throw new PaymentError("failed", verification.error ?? "Payment is still confirming");
      await createTransaction({
        telegramId: user.telegramUser.id,
        type: "wallet_verification",
        amount: VERIFY_AMOUNT,
        currency: "ton",
        walletAddress: address,
        txHash: verification.tx_hash || null,
      });
      setIsVerified(true);
      setVerifyOpen(false);
      toast({ title: "Wallet verified", description: "Your wallet ownership is confirmed" });
      if (!hasNft) setReqOpen("nft");
      else if (stakedTon < STAKE_MIN_GRAM) setReqOpen("stake");
      else {
        setWithdrawCurrency("ton");
        setWithdrawOpen(true);
      }
    } catch (err) {
      if (err instanceof PaymentError) {
        toast({
          title: err.code === "not_connected" ? "Wallet not connected" : "Verification failed",
          description: err.message,
          variant: "destructive",
        });
      } else {
        toast({ title: "Verification failed", description: "Please try again", variant: "destructive" });
      }
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen pb-28">
      <SpotlightHero title="Wallet">
      <div className="px-5 pt-8">


      {/* Total balance */}
      <motion.div
        className="paper-card mb-4 p-6 text-center"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <p className="paper-eyebrow">Total balance</p>
        <h2 className="mt-1 font-display text-[44px] leading-none tracking-tight text-foreground">
          ${(user.tonBalance * (markets["the-open-network"]?.price || TON_USD) + user.usdtBalance + Number(user.rewardBalance ?? 0)).toFixed(2)}
        </h2>

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => setDepositOpen(true)}
            className="btn-ink h-12 gap-2 text-[11px] font-semibold uppercase tracking-widest"
          >
            <ArrowDownToLine className="h-4 w-4" /> Deposit
          </button>
          <button
            type="button"
            onClick={openWithdrawFlow}
            className="btn-ink-soft h-12 gap-2 text-[11px] font-semibold uppercase tracking-widest"
          >
            <ArrowUpFromLine className="h-4 w-4" /> Withdraw
          </button>
        </div>
      </motion.div>

      {/* Assets — iOS grouped list */}
      <p className="paper-eyebrow mb-2 px-1">Assets</p>
      <motion.div
        className="paper-card mb-4 overflow-hidden p-0"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        {Number(user.rewardBalance ?? 0) > 0 && (
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">Locked USDT</p>
              <p className="text-[11px] text-muted-foreground">Prize reward</p>
            </div>
            <div className="text-right">
              <p className="font-display text-base text-foreground">
                {Number(user.rewardBalance).toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </p>
              <p className="text-[11px] text-muted-foreground">
                ≈ ${Number(user.rewardBalance).toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        )}
        {balances.map((b) => (
          <div key={b.symbol} className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-card">
              <img
                src={b.icon || NOVA_ICON}
                alt={b.symbol}
                className="h-full w-full rounded-full object-cover"
                loading="lazy"
              />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{b.symbol}</p>
              <p className="text-[11px] text-muted-foreground">
                {b.price > 0 ? formatUsd(b.price) : "—"}
              </p>
            </div>
            <div className="text-right">
              <p className="font-display text-base text-foreground">
                {b.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </p>
              {b.symbol !== "$NOVA" && (
                <p className="text-[11px] text-muted-foreground">
                  ≈ ${b.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </p>
              )}
            </div>
          </div>
        ))}
      </motion.div>


      {/* Connection */}
      <p className="paper-eyebrow mb-2 px-1">Wallet</p>
      <motion.div
        className="paper-card divide-y divide-border/25 overflow-hidden p-0"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Connected
            </p>
            <p className="truncate font-mono text-xs text-foreground">
              {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!address) return;
              navigator.clipboard.writeText(address);
              toast({ title: "Address copied" });
            }}
            className="btn-ink-soft h-9 w-9 shrink-0"
            aria-label="Copy wallet address"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={handleDisconnect}
          className="flex w-full items-center justify-center gap-2 px-4 py-3.5 text-sm font-medium text-destructive"
        >
          <Power className="h-4 w-4" /> Disconnect
        </button>

      </motion.div>


      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="fixed bottom-auto left-1/2 right-auto top-1/2 w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[32px] border-0 bg-transparent p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-[360px] sm:-translate-x-1/2 sm:-translate-y-1/2">
          <div className="wallet-dialog-surface relative w-full overflow-hidden rounded-[32px] px-7 pb-8 pt-9 text-center">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[32px] opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, hsl(0 0% 100% / 0.16) 0%, hsl(0 0% 100% / 0.05) 45%, transparent 100%)",
              }}
            />
            <DialogHeader className="relative z-10">
              <DialogTitle className="text-center text-[10px] font-normal uppercase tracking-[0.34em] text-muted-foreground">
                Deposit Gram
              </DialogTitle>
              <DialogDescription className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                Send Gram from your connected wallet
              </DialogDescription>
            </DialogHeader>
            <Input
              placeholder="Amount in Gram"
              type="number"
              className="wallet-dialog-field relative z-10 mt-6 h-12 rounded-2xl text-center text-[16px]"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
            />
            <Button
              onClick={handleDeposit}
              className="relative z-10 mt-4 h-12 w-full rounded-2xl font-display text-[15px] font-medium glow-primary"
            >
              Send deposit
            </Button>

            <div className="relative z-10 mt-6">
              <p className="text-center text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                or pay with Telegram Stars
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {STAR_PACKS.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    disabled={starBusy}
                    onClick={() => void handleStarsTopUp(pack.id)}
                    className="rounded-2xl border border-border bg-secondary px-2 py-3 text-center transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <span className="block font-display text-[15px] font-medium text-foreground">
                      {pack.usdt} USDT
                    </span>
                    <span className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                      <TelegramStar className="h-3.5 w-3.5" />
                      {STARS_PRICES[pack.id]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="fixed bottom-auto left-1/2 right-auto top-1/2 w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[32px] border-0 bg-transparent p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-[360px] sm:-translate-x-1/2 sm:-translate-y-1/2">
          <div className="wallet-dialog-surface relative rounded-[32px] px-7 pb-8 pt-9 text-center">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[32px] opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, hsl(0 0% 100% / 0.16) 0%, hsl(0 0% 100% / 0.05) 45%, transparent 100%)",
              }}
            />
            <DialogHeader className="relative z-10">
              <DialogTitle className="text-center text-[10px] font-normal uppercase tracking-[0.34em] text-muted-foreground">
                Withdraw
              </DialogTitle>
              <DialogDescription className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                Choose a currency and amount
              </DialogDescription>
            </DialogHeader>
            <div className="relative z-10 mt-6 grid grid-cols-2 gap-1.5 rounded-2xl border border-border bg-secondary p-1.5">
              {(["ton", "usdt"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setWithdrawCurrency(c)}
                  className={`h-11 rounded-xl font-display text-[14px] transition-all ${
                    withdrawCurrency === c
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {c === "ton" ? "Gram" : "USDT"}
                </button>
              ))}
            </div>
            <Input
              placeholder={`Amount in ${withdrawCurrency === "ton" ? "Gram" : "USDT"}`}
              type="number"
              className="wallet-dialog-field relative z-10 mt-4 h-12 rounded-2xl text-center text-[16px]"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
            />
            <Button
              onClick={handleWithdraw}
              className="relative z-10 mt-4 h-12 w-full rounded-2xl font-display text-[15px] font-medium glow-primary"
            >
              Request withdrawal
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={verifyOpen} onOpenChange={setVerifyOpen}>
        <DialogContent className="fixed bottom-auto left-1/2 right-auto top-1/2 w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[32px] border-0 bg-transparent p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-[360px] sm:-translate-x-1/2 sm:-translate-y-1/2">
          <div
            className="relative rounded-[32px] px-7 pb-8 pt-9 text-center"
            style={{
              background: "hsl(0 0% 100% / 0.85)",
              backdropFilter: "blur(32px) saturate(180%)",
              WebkitBackdropFilter: "blur(32px) saturate(180%)",
              border: "1px solid hsl(160 18% 90%)",
              boxShadow: "0 24px 70px -20px rgba(0,0,0,0.6), inset 0 1px 0 hsl(0 0% 100% / 0.12)",
            }}
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[32px] opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, hsl(0 0% 100% / 0.16) 0%, hsl(0 0% 100% / 0.05) 45%, transparent 100%)",
              }}
            />
            <DialogHeader className="relative z-10">
              <DialogTitle className="text-[10px] font-normal uppercase tracking-[0.34em] text-muted-foreground">
                Wallet verification
              </DialogTitle>
              <DialogDescription className="sr-only">One-time wallet verification fee</DialogDescription>
            </DialogHeader>
            <div className="relative z-10 mt-6 rounded-[28px] border border-white/[0.08] bg-foreground/[0.05] px-5 py-6">
              <p className="text-[38px] font-display font-medium leading-none text-gradient-primary">
                {VERIFY_AMOUNT} Gram
              </p>
              <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">One-time fee</p>
            </div>
            <p className="relative z-10 mt-5 text-[12px] leading-relaxed text-muted-foreground">
              Verify wallet ownership to unlock withdrawals. This is required once.
            </p>
            <p className="relative z-10 mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Keep at least {(VERIFY_AMOUNT + TON_FEE_BUFFER).toFixed(2)} Gram in your wallet so the network fee is
              covered.
            </p>
            <button
              onClick={() => setWhyOpen((v) => !v)}
              className="relative z-10 mt-4 text-[11px] uppercase tracking-[0.2em] text-primary underline-offset-4 transition-colors hover:text-primary/80 hover:underline"
            >
              Why do we verify?
            </button>
            {whyOpen && (
              <p className="relative z-10 mt-4 rounded-[24px] border border-white/[0.08] bg-foreground/[0.05] p-4 text-left text-[12px] leading-relaxed text-muted-foreground">
                We have many investors, so every account must be proven real and not fake — the prize must never go
                to a fake account. The verification fee proves wallet ownership, protects everyone's funds, and
                unlocks all future withdrawals.
              </p>
            )}
            <Button
              onClick={handleVerifyWallet}
              disabled={verifying}
              className="relative z-10 mt-6 h-12 w-full rounded-2xl font-display text-[15px] font-medium glow-primary"
            >
              {verifying ? "Verifying" : `Pay ${VERIFY_AMOUNT} Gram and verify`}
            </Button>
            <button
              onClick={() => setVerifyOpen(false)}
              className="relative z-10 mt-3 text-[11px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reqOpen !== null} onOpenChange={(o) => !o && setReqOpen(null)}>
        <DialogContent className="fixed bottom-auto left-1/2 right-auto top-1/2 w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[32px] border-0 bg-transparent p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-[360px] sm:-translate-x-1/2 sm:-translate-y-1/2">
          <div
            className="relative rounded-[32px] px-7 pb-8 pt-9 text-center"
            style={{
              background: "hsl(0 0% 100% / 0.85)",
              backdropFilter: "blur(32px) saturate(180%)",
              WebkitBackdropFilter: "blur(32px) saturate(180%)",
              border: "1px solid hsl(160 18% 90%)",
              boxShadow: "0 24px 70px -20px rgba(0,0,0,0.6), inset 0 1px 0 hsl(0 0% 100% / 0.12)",
            }}
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[32px] opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, hsl(0 0% 100% / 0.16) 0%, hsl(0 0% 100% / 0.05) 45%, transparent 100%)",
              }}
            />
            <DialogHeader className="relative z-10">
              <DialogTitle className="text-[10px] font-normal uppercase tracking-[0.34em] text-muted-foreground">
                Withdrawal requirement
              </DialogTitle>
              <DialogDescription className="sr-only">Requirement details</DialogDescription>
            </DialogHeader>
            <div className="relative z-10 mt-6 rounded-[28px] border border-white/[0.08] bg-foreground/[0.05] px-5 py-6">
              <p className="text-[38px] font-display font-medium leading-none text-gradient-primary">
                {reqOpen === "nft" ? NFT_MIN_GRAM : STAKE_MIN_GRAM} Gram
              </p>
              <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {reqOpen === "nft" ? "Minimum NFT value" : "Minimum stake"}
              </p>
            </div>
            <p className="relative z-10 mt-5 text-[12px] leading-relaxed text-muted-foreground">
              {reqOpen === "nft"
                ? `Own an NFT worth at least ${NFT_MIN_GRAM} Gram to unlock withdrawals. This confirms the account is active and real before the prize is released.`
                : `Stake at least ${STAKE_MIN_GRAM} Gram on the Bonds page to unlock withdrawals. You currently have ${stakedTon.toLocaleString("en-US", { maximumFractionDigits: 2 })} Gram staked.`}
            </p>
            <Button
              onClick={() => {
                const to = reqOpen === "nft" ? "/servers" : "/staking";
                setReqOpen(null);
                navigate(to);
              }}
              className="relative z-10 mt-6 h-12 w-full rounded-2xl font-display text-[15px] font-medium glow-primary"
            >
              {reqOpen === "nft" ? "Buy NFT" : "Go to staking"}
            </Button>
            <button
              onClick={() => setReqOpen(null)}
              className="relative z-10 mt-3 text-[11px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
            >
              Later
            </button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
      </SpotlightHero>
    </div>
  );
};

export default WalletPage;
