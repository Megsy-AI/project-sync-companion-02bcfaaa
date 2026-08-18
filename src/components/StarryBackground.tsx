import { useEffect, useRef } from "react";

const bgVideoMp4 = "/bg-loop.mp4";

/** Global video background shared by every page. */
const StarryBackground = () => {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    const play = () => void v.play().catch(() => undefined);
    play();
    document.addEventListener("touchstart", play, { once: true });
    document.addEventListener("click", play, { once: true });

    // Stop decoding frames while the mini app is in the background.
    const onVisibility = () => {
      if (document.hidden) v.pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("touchstart", play);
      document.removeEventListener("click", play);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="liquid-bg" aria-hidden="true">
      <video
        ref={ref}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        poster="/images/bg-poster.jpg"
        className="absolute inset-0 h-full w-full object-cover"
      >
        <source src={bgVideoMp4} type="video/mp4" />
      </video>
    </div>
  );
};

export default StarryBackground;
