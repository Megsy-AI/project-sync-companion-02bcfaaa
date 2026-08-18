import SpotlightHero from "@/components/hero/SpotlightHero";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/hooks/use-toast";
import ServerArtwork from "@/components/ServerArtwork";
import { useNftArt } from "@/hooks/use-nft-art";
import { swr } from "@/lib/cache";
import CachedImage from "@/components/CachedImage";
import { payWithStars, starsForTon } from "@/lib/stars";
import TelegramStar from "@/components/TelegramStar";
import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { PaymentError, sendTonPayment } from "@/lib/ton";
import { purchaseServerForTelegram, verifyTonOnChain } from "@/lib/game-api";
import { usePaymentDiscount } from "@/hooks/use-payment-discount";
import DiscountBanner from "@/components/DiscountBanner";
import NftExplainer from "@/components/NftExplainer";


const TON_ICON = "/images/gram-icon.png";
const USDT_ICON = "/images/usdt.png";


interface Server {
  id: string;
  name: string;
  image_url: string;
  price_ton: number;
  rarity: string;
  mining_boost: number | null;
  attack_boost: number | null;
  ton_mining_rate: number | null;
  usdt_mining_rate: number | null;
}


const ServersPage = () => {
  const { user, refreshProfile } = useApp();
  const { toast } = useToast();
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [myNfts, setMyNfts] = useState<{ id: string; name: string; image_url: string }[]>([]);
  const [starBusy, setStarBusy] = useState<string | null>(null);
  const [tonBusy, setTonBusy] = useState<string | null>(null);
  const [tonConnectUI] = useTonConnectUI();
  const walletAddress = useTonAddress();
  const nftArt = useNftArt();
  const { discount, priceFor, refresh: refreshDiscount, requestSmartOffer, thinking: offerThinking } = usePaymentDiscount();


  useEffect(() => { void loadServers(); void loadMyNfts(); }, []);

  const loadServers = async () => {
    await swr<Server[]>(
      "servers",
      async () => {
        const { data } = await supabase.from("servers").select("*").eq("is_active", true).order("price_ton", { ascending: true });
        return (data || []) as Server[];
      },
      (rows) => {
        setServers(rows);
        setLoading(false);
      },
      10 * 60 * 1000,
    );
    setLoading(false);
  };

  const loadMyNfts = async () => {
    const { data } = await supabase
      .from("user_nfts")
      .select("id, name, image_url")
      .eq("telegram_id", user.telegramUser.id)
      .order("created_at", { ascending: false });
    if (data) setMyNfts(data);
  };


  const handleBuyWithStars = async (server: Server) => {
    setStarBusy(server.id);
    try {
      const status = await payWithStars("server", user.profileId, user.telegramUser.id, {
        serverId: server.id,
      });
      if (status === "paid") {
        await refreshProfile();
        toast({ title: "Purchase complete", description: `${server.name} added successfully` });
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
      setStarBusy(null);
    }
  };

  const handleBuyWithTon = async (server: Server) => {
    // The server recomputes the discount on the intent; send the base price.
    const price = Number(server.price_ton);
    setTonBusy(server.id);
    try {
      const transaction = await sendTonPayment(tonConnectUI, {
        amountTon: price,
        telegramId: user.telegramUser.id,
        action: "server",
        metadata: { serverId: server.id },
      });

      toast({ title: "Verifying payment...", description: "Checking blockchain confirmation" });
      const verification = await verifyTonOnChain(transaction.intentId, transaction.boc, tonConnectUI.account?.address);
      if (!verification.verified) {
        toast({ title: "Verification failed", description: "Transaction not found on blockchain.", variant: "destructive" });
        return;
      }

      await purchaseServerForTelegram({
        telegramId: user.telegramUser.id,
        serverId: server.id,
        tonPaid: transaction.amountTon,
        walletAddress,
        txHash: verification.tx_hash || transaction?.boc,
      });

      await refreshProfile();
      void refreshDiscount();
      toast({ title: "Purchase complete", description: `${server.name} added successfully` });
    } catch (err) {
      if (err instanceof PaymentError) {
        toast({
          title: err.code === "not_connected" ? "Wallet not connected" : "Payment failed",
          description: err.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Purchase failed", description: "Please try again", variant: "destructive" });
    } finally {
      setTonBusy(null);
    }
  };



  if (loading) {
    return <div className="min-h-screen bg-gradient-dark flex items-center justify-center"><div className="text-muted-foreground font-display animate-pulse">Loading...</div></div>;
  }


  const handleSmartOffer = async (surface: "servers" | "shop") => {
    const ok = await requestSmartOffer(surface);
    if (!ok) {
      toast({ title: "Offer unavailable", description: "Try again in a moment", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen pb-28">
      <SpotlightHero title="Servers">
      <div className="px-5 pt-6">

      <NftExplainer />

      <DiscountBanner discount={discount} thinking={offerThinking} onSmartOffer={() => void handleSmartOffer("servers")} />

      {myNfts.length > 0 && (
        <div className="mb-6">
          <h2 className="paper-eyebrow mb-3">Your creations</h2>
          <div className="grid grid-cols-2 gap-3">
            {myNfts.map((n) => (
              <div key={n.id} className="paper-card p-3">
                <CachedImage src={n.image_url} alt={n.name} className="mb-2 w-full rounded-xl object-cover" />
                <p className="text-center text-xs font-semibold text-foreground">{n.name}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No servers available</div>
      ) : (
        <>
          <h2 className="paper-eyebrow mb-3">Mining servers</h2>
          <div className="space-y-3">
            {servers.map((server, i) => (
              <motion.div
                key={server.id}
                className="paper-card overflow-hidden p-0"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: Math.min(i, 8) * 0.04 }}
              >
                <img
                  src={nftArt[i % (nftArt.length || 1)] || server.image_url}
                  alt={`${server.name} NFT`}
                  className="block aspect-square w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />

                <div className="px-4 pt-3">
                  <h3 className="font-display text-xl leading-none text-foreground">{server.name}</h3>

                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span>Mining +{server.mining_boost || 0}%</span>
                    <span>Attack +{server.attack_boost || 0}%</span>
                    <span className="flex items-center gap-1">
                      <img src={TON_ICON} alt="Gram" className="h-3 w-3 rounded-full" loading="lazy" decoding="async" />
                      +{server.ton_mining_rate || 0}/d
                    </span>
                    <span className="flex items-center gap-1">
                      <img src={USDT_ICON} alt="USDT" className="h-3 w-3" loading="lazy" decoding="async" />
                      +{server.usdt_mining_rate || 0}/d
                    </span>
                  </div>
                </div>


                <div className="mt-4 grid grid-cols-2 gap-2 px-4 pb-4">
                  <button
                    type="button"
                    className="btn-ink h-11 text-xs font-semibold"
                    onClick={() => void handleBuyWithTon(server)}
                    disabled={tonBusy === server.id}
                  >
                    {tonBusy === server.id ? (
                      <span className="animate-pulse">Processing…</span>
                    ) : (
                      <span className="flex items-center justify-center gap-1.5">
                        <img src={TON_ICON} alt="" className="h-3.5 w-3.5 rounded-full" loading="lazy" decoding="async" />
                        {discount.discount_pct > 0 && (
                          <span className="line-through opacity-50">{Number(server.price_ton)}</span>
                        )}
                        {priceFor(Number(server.price_ton))} TON
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn-ink-soft h-11 text-xs font-semibold"
                    onClick={() => void handleBuyWithStars(server)}
                    disabled={starBusy === server.id}
                  >
                    {starBusy === server.id ? (
                      <span className="animate-pulse">Opening…</span>
                    ) : (
                      <span className="flex items-center justify-center gap-1.5">
                        <TelegramStar className="h-3.5 w-3.5" />
                        {starsForTon(priceFor(Number(server.price_ton))).toLocaleString()}
                      </span>
                    )}
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </>
      )}
      </div>
      </SpotlightHero>
    </div>
  );
};

export default ServersPage;

