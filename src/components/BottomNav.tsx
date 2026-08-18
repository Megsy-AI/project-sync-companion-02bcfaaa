import { Pickaxe, Gamepad2, CircleCheckBig, Gem, Wallet } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { prefetchRoute } from "@/routes";

const navItems = [
  { to: "/", icon: Pickaxe, label: "Mine" },
  { to: "/ai", icon: Gamepad2, label: "Games" },
  { to: "/tasks", icon: CircleCheckBig, label: "Tasks" },
  { to: "/servers", icon: Gem, label: "NFT" },
  { to: "/wallet", icon: Wallet, label: "Wallet" },
];

const BottomNav = () => {
  const location = useLocation();

  return (
        <motion.nav
          key="bottom-nav"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-0 left-0 right-0 z-[100] px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.6rem)] pt-2"
        >
          <div className="mx-auto flex max-w-sm items-center justify-between gap-1 rounded-[26px] border border-white/12 bg-[rgba(18,26,24,0.72)] px-2 py-2 backdrop-blur-2xl shadow-[0_20px_44px_-24px_rgba(0,0,0,0.9)]">
            {navItems.map((item) => {
              const isActive =
                location.pathname === item.to || (item.to !== "/" && location.pathname.startsWith(item.to));

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
                    const scrollingElement = document.scrollingElement;
                    if (scrollingElement) scrollingElement.scrollTop = 0;
                  }}
                  onMouseEnter={() => prefetchRoute(item.to)}
                  onTouchStart={() => prefetchRoute(item.to)}
                  className="relative flex flex-1 flex-col items-center justify-center gap-1 rounded-[20px] py-1.5"
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-[20px] bg-white/10"
                      transition={{ type: "spring", stiffness: 480, damping: 40 }}
                    />
                  )}
                  <item.icon
                    className={cn(
                      "relative h-[19px] w-[19px] shrink-0 transition-colors duration-200",
                      isActive ? "text-white" : "text-white/45",
                    )}
                    strokeWidth={isActive ? 2.2 : 1.7}
                  />
                  <span
                    className={cn(
                      "relative text-[10px] font-medium tracking-tight transition-colors duration-200",
                      isActive ? "text-white" : "text-white/45",
                    )}
                  >
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </motion.nav>
  );
};

export default BottomNav;
