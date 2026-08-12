"use client";

import { type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepsProps = ComponentProps<"div"> & {
  defaultOpen?: boolean;
};

export function Steps({
  defaultOpen = true,
  className,
  children,
  ...props
}: StepsProps) {
  return (
    <div
      className={cn("space-y-0", className)}
      data-open={defaultOpen}
      {...props}
    >
      {children}
    </div>
  );
}

export type StepsItemProps = ComponentProps<"div"> & {
  defaultOpen?: boolean;
};

export function StepsItem({
  children,
  className,
  defaultOpen = true,
  ...props
}: StepsItemProps) {
  return (
    <div
      className={cn("group/step", className)}
      data-open={defaultOpen}
      {...props}
    >
      {children}
    </div>
  );
}

export type StepsTriggerProps = ComponentProps<"button"> & {
  leftIcon?: ReactNode;
  swapIconOnHover?: boolean;
};

export function StepsTrigger({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  ...props
}: StepsTriggerProps) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full cursor-pointer items-center justify-start gap-2 py-2 text-left text-[12px] text-zinc-500 transition-colors hover:text-zinc-200",
        className,
      )}
      {...props}
    >
      {leftIcon ? (
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <span
            className={cn(
              "transition-opacity",
              swapIconOnHover && "group-hover:opacity-0",
            )}
          >
            {leftIcon}
          </span>
          {swapIconOnHover ? (
            <ChevronDown className="absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-data-[state=open]:rotate-180" />
          ) : null}
        </span>
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-zinc-600 transition-transform group-data-[state=open]:rotate-180" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

export type StepsContentProps = ComponentProps<"div"> & {
  bar?: ReactNode;
};

export function StepsContent({
  children,
  className,
  bar,
  ...props
}: StepsContentProps) {
  return (
    <div className={cn("flex gap-3 pb-2 pl-1", className)} {...props}>
      {bar ?? <StepsBar />}
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-zinc-400">
        {children}
      </div>
    </div>
  );
}

export type StepsBarProps = ComponentProps<"div">;

export function StepsBar({ className, ...props }: StepsBarProps) {
  return (
    <div
      className={cn("mt-1 h-auto w-[2px] shrink-0 bg-white/[0.08]", className)}
      aria-hidden
      {...props}
    />
  );
}
