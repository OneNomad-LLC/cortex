/**
 * Active-seat toggle. Flips a member's `active` bit via the
 * `/api/dashboard/seats/:userId` bridge route. Gated to Business+ orgs
 * by the server (returns a 402-style hint at lower tiers); this component
 * shows a disabled state with a tooltip if the seat cap is not configured.
 *
 * Props:
 *   userId     — app_user id
 *   active     — current seat state
 *   disabled   — true when seats are unconfigured (PRZM_ACCESS_ORG_ID missing)
 *   onToggle   — callback called with the optimistic next value; caller owns
 *               mutation state and revalidation
 */

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SeatToggleProps {
  userId: string;
  active: boolean;
  disabled?: boolean;
  isPending?: boolean;
  onToggle: (userId: string, nextActive: boolean) => void;
}

export function SeatToggle({
  userId,
  active,
  disabled = false,
  isPending = false,
  onToggle,
}: SeatToggleProps): React.ReactElement {
  const toggle = (
    <Switch
      checked={active}
      disabled={disabled || isPending}
      onCheckedChange={(checked) => onToggle(userId, checked)}
      aria-label={active ? "Deactivate seat" : "Activate seat"}
      className={cn(isPending && "opacity-50")}
    />
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{toggle}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            Set PRZM_ACCESS_ORG_ID in the workspace .env to enable seat management.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return toggle;
}
