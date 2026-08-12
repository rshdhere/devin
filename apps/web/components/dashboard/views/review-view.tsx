"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  GitPullRequest,
  RefreshCw,
  X,
} from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
const waitingReviews = [
  {
    id: "1",
    title: "test: should fail the tests #2",
    meta: "9mo • rshdhere • rshdhere/testing-sprint",
    status: "failed" as const,
  },
  {
    id: "2",
    title: "test: should pass all tests #1",
    meta: "9mo • rshdhere • rshdhere/testing-sprint",
    status: "passed" as const,
  },
];

export function ReviewView() {
  const [prUrl, setPrUrl] = useState("");

  return (
    <div className="flex w-full max-w-[900px] flex-col">
      <div className="mb-6 flex items-center gap-3">
        <MotionButton
          type="button"
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[13px] text-gray-300 transition-colors hover:bg-[#222]"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-[#3a3a3a] text-[10px] font-semibold">
            R
          </span>
          rshdhere
          <ChevronDown className="size-3.5 text-gray-500" />
        </MotionButton>

        <MotionButton
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[13px] text-gray-400 transition-colors hover:bg-[#222]"
        >
          All repositories
          <ChevronDown className="size-3.5" />
        </MotionButton>

        <MotionButton
          type="button"
          pressStyle="icon"
          className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
          aria-label="Refresh"
        >
          <RefreshCw className="size-4" />
        </MotionButton>

        <div className="ml-auto max-w-[280px] flex-1">
          <input
            type="text"
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            placeholder="Paste pull request URL"
            className="w-full rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-2 text-[13px] text-white outline-none placeholder:text-gray-500 focus:border-[#444]"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-[14px] text-gray-400">
        <Clock className="size-4" />
        <span>Waiting for reviewers</span>
      </div>

      <div className="mt-4 space-y-1">
        {waitingReviews.map((item) => (
          <MotionButton
            key={item.id}
            type="button"
            className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-[#1a1a1a]"
          >
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-white">
                  {item.title}
                </span>
                {item.status === "failed" ? (
                  <X className="size-3.5 text-red-400" />
                ) : (
                  <Check className="size-3.5 text-emerald-400" />
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-gray-500">{item.meta}</p>
            </div>
          </MotionButton>
        ))}
      </div>
    </div>
  );
}

export const reviewRecentItems = [
  {
    id: "r1",
    title: "refactor(llm): centralize system prom...",
    meta: "4 months ago • kasyap1234",
  },
  {
    id: "r2",
    title: "test: should fail the tests",
    meta: "9 months ago • rshdhere",
  },
  {
    id: "r3",
    title: "test: should pass all tests",
    meta: "9 months ago • rshdhere",
  },
];
