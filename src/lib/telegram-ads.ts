// Ads helper: RichAds (https://richads.com/publishers/telegram) only.
// Rewarded/interstitial video first (highest paying), loaded and shown on demand.
// Nothing is loaded until the user taps "Watch", so no auto banners or push ads.

const RICHADS_SDK = "https://richinfo.co/richpartners/telegram/js/tg-ob.js";

const RICHADS_PUB_ID =
  (import.meta.env.VITE_RICHADS_PUB_ID as string | undefined) ||
  ((window as any).RICHADS_PUB_ID as string | undefined) ||
  "998796";

const RICHADS_APP_ID =
  (import.meta.env.VITE_RICHADS_APP_ID as string | undefined) ||
  ((window as any).RICHADS_APP_ID as string | undefined) ||
  "8586";

/** Last failure reason, surfaced in the UI so problems are diagnosable. */
export let lastAdError = "";

const scriptCache = new Map<string, Promise<boolean>>();

const loadScript = (src: string): Promise<boolean> => {
  const cached = scriptCache.get(src);
  if (cached) return cached;

  const promise = new Promise<boolean>((resolve) => {
    try {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve(true);
      el.onerror = () => resolve(false);
      document.head.appendChild(el);
    } catch {
      resolve(false);
    }
  });

  scriptCache.set(src, promise);
  return promise;
};

export const isAdsReady = () => true;

let richController: any = null;
let initialised = false;

/** The SDK reads the Telegram user itself; it only works inside Telegram. */
const telegramUserId = (): number | undefined =>
  (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;

/** initDataUnsafe can populate a moment after the WebApp script runs. */
const waitForTelegramUser = async (timeoutMs = 3000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (telegramUserId()) return true;
    try {
      (window as any).Telegram?.WebApp?.ready?.();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return !!telegramUserId();
};

/**
 * Highest-paying formats first: video > mixed > banner > native notification.
 * Verified against the live SDK: every name below exists on the controller.
 */
const AD_METHODS = [
  "triggerInterstitialVideo",
  "triggerInterstitialMixed",
  "triggerInterstitialBanner",
  "triggerBannerAds",
  "triggerNativeNotification",
];

/** Rejects if a promise hangs longer than `ms`. */
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const getRichController = async (): Promise<any> => {
  if (richController && initialised) return richController;

  const loaded = await withTimeout(loadScript(RICHADS_SDK), 8000, "sdk").catch(() => false);
  if (!loaded) {
    lastAdError = "SDK failed to load";
    return null;
  }

  const Ctor = (window as any).TelegramAdsController;
  if (typeof Ctor !== "function") {
    lastAdError = "SDK unavailable";
    return null;
  }

  if (!(await waitForTelegramUser())) {
    lastAdError = "Ads only work inside Telegram";
    return null;
  }

  if (!richController) richController = new Ctor();

  try {
    // initialize() resolves once the publisher configuration is fetched.
    await withTimeout(
      Promise.resolve(
        richController.initialize({ pubId: RICHADS_PUB_ID, appId: String(RICHADS_APP_ID), debug: false }),
      ),
      8000,
      "init",
    );
    initialised = true;
  } catch (e: any) {
    initialised = false;
    // Drop the half-initialised instance so the next tap starts clean.
    richController = null;
    lastAdError = `init: ${e?.message ?? "failed"}`;
    return null;
  }


  return richController;
};

/**
 * Shows exactly one RichAds ad, only when called from a user action
 * (the "Watch" button). Tries every format, highest paying first.
 * Every step is time-boxed so the button never stays stuck on "Loading...".
 */
export const showAd = async (): Promise<boolean> => {
  lastAdError = "";
  const controller = await getRichController();
  if (!controller) return false;

  for (const method of AD_METHODS) {
    const fn = controller[method];
    if (typeof fn !== "function") continue;
    try {
      const out = fn.call(controller);
      if (out && typeof out.then === "function") {
        try {
          const res = await withTimeout(out, 20000, method);
          if (res === false) continue;
          return true;
        } catch (err: any) {
          if (String(err?.message ?? "").includes("timeout")) {
            // The ad view is open but the SDK never settles: count it as shown.
            return true;
          }
          throw err;
        }
      }
      if (out === false) continue;
      return true;
    } catch (e: any) {
      lastAdError = `${method}: ${e?.message ?? "no fill"}`;
      // no fill for this format, try the next one
    }
  }
  if (!lastAdError) lastAdError = "No fill";
  return false;
};

