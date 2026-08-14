"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, LogOut, X } from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface UserMenuProps {
  userName: string;
  collapsed?: boolean;
}

function getInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "U";
}

const menuTransition = {
  duration: 0.24,
  ease: "easeIn" as const,
};

export function UserMenu({ userName, collapsed = false }: UserMenuProps) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [logoutConfirmPending, setLogoutConfirmPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setLogoutConfirmPending(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (
        target.closest("[data-user-menu]") ||
        target.closest("[data-user-menu-trigger]")
      ) {
        return;
      }
      setOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      setMenuPosition(null);
      return;
    }

    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 6,
      left: rect.left,
      width: Math.max(rect.width, 268),
    });
    setOpen(true);
  }

  async function handleLogout() {
    setIsSigningOut(true);
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            setOpen(false);
            router.replace("/login");
          },
        },
      });
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <>
      <MotionButton
        ref={triggerRef}
        type="button"
        data-user-menu-trigger
        onClick={toggleMenu}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[#1a1a1a]",
          collapsed ? "justify-center" : "min-w-0 flex-1",
          open && "bg-[#1a1a1a]",
        )}
        aria-label={collapsed ? userName : undefined}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#3a3a3a] text-[12px] font-semibold text-white">
          {getInitial(userName)}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-gray-100">
              {userName}
            </span>
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-gray-500 transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </>
        ) : null}
      </MotionButton>

      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open && menuPosition ? (
                <motion.div
                  data-user-menu
                  className="fixed z-[200] overflow-hidden rounded-xl border border-[#333] bg-[#1e1e1e] shadow-2xl"
                  style={{
                    top: menuPosition.top,
                    left: menuPosition.left,
                    width: menuPosition.width,
                  }}
                  initial={{ opacity: 0, scale: 0.96, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={menuTransition}
                >
                  <div className="flex items-start gap-3 px-4 py-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#3a3a3a] text-[15px] font-semibold text-white">
                      {getInitial(userName)}
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <p className="truncate text-[15px] font-semibold text-white">
                        {userName}
                      </p>
                      <p className="mt-0.5 text-[13px] text-gray-500">
                        Organization • 1 member
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 px-3 pb-3">
                    <MotionButton
                      type="button"
                      className="cursor-pointer rounded-lg bg-[#333] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#3d3d3d]"
                    >
                      Settings
                    </MotionButton>
                    <MotionButton
                      type="button"
                      className="cursor-pointer rounded-lg bg-[#333] px-3 py-2 text-[13px] font-medium text-[#5a9fd4] transition-colors hover:bg-[#3d3d3d] hover:text-[#6aa8ef]"
                    >
                      Upgrade
                    </MotionButton>
                  </div>

                  <div className="border-t border-[#2a2a2a] py-1">
                    <MotionButton
                      type="button"
                      className="flex w-full cursor-pointer px-4 py-2.5 text-left text-[14px] text-gray-200 transition-colors hover:bg-[#252525]"
                    >
                      Create new organization
                    </MotionButton>
                    <div
                      className={cn(
                        "flex w-full items-center transition-colors hover:bg-[#252525]",
                        logoutConfirmPending && "bg-[#252525]/60",
                      )}
                    >
                      <MotionButton
                        type="button"
                        disabled={isSigningOut}
                        onClick={() => setLogoutConfirmPending(true)}
                        className="flex flex-1 cursor-pointer px-4 py-2.5 text-left text-[14px] text-gray-200 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSigningOut ? "Logging out…" : "Log out"}
                      </MotionButton>
                      {logoutConfirmPending && !isSigningOut ? (
                        <div className="flex items-center gap-0.5 pr-2">
                          <MotionButton
                            type="button"
                            pressStyle="icon"
                            onClick={() => void handleLogout()}
                            className="cursor-pointer rounded-md p-1.5 text-red-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
                            aria-label="Confirm log out"
                          >
                            <LogOut className="size-4" />
                          </MotionButton>
                          <MotionButton
                            type="button"
                            pressStyle="icon"
                            onClick={() => setLogoutConfirmPending(false)}
                            className="cursor-pointer rounded-md p-1.5 text-gray-500 transition-colors hover:bg-[#333] hover:text-gray-300"
                            aria-label="Cancel log out"
                          >
                            <X className="size-4" />
                          </MotionButton>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
