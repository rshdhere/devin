"use client";

import { useLayoutEffect, type RefObject } from "react";
import {
  CHAT_MORPH_FADE_MS,
  CHAT_MORPH_HANDOFF_MS,
} from "@/components/dashboard/prompt-composer-constants";
import { useSessions } from "@/components/dashboard/sessions-context";

/**
 * After expand + route: snap overlay to the real chat slot (instant), hold so
 * the workspace diamond is visible, then crossfade. No second expand.
 */
export function useChatSlotMorphHandoff(
  slotRef: RefObject<HTMLElement | null>,
) {
  const {
    isLaunchMorphing,
    alignLaunchMorphToSlot,
    beginLaunchMorphFade,
    completeLaunchMorph,
  } = useSessions();

  useLayoutEffect(() => {
    if (!isLaunchMorphing) {
      return;
    }

    const slot = slotRef.current;
    if (slot) {
      alignLaunchMorphToSlot(slot);
    }

    const fadeTimer = window.setTimeout(() => {
      beginLaunchMorphFade();
    }, CHAT_MORPH_HANDOFF_MS);

    const doneTimer = window.setTimeout(() => {
      completeLaunchMorph();
    }, CHAT_MORPH_HANDOFF_MS + CHAT_MORPH_FADE_MS);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, [
    isLaunchMorphing,
    slotRef,
    alignLaunchMorphToSlot,
    beginLaunchMorphFade,
    completeLaunchMorph,
  ]);
}
