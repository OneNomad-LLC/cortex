import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Plain <label> wrapper — same visual contract as shadcn's Radix-based
 * Label, without the Radix dependency. We don't need the
 * focus-management features of `@radix-ui/react-label` yet; if/when
 * that shows up (combobox label-clicks etc.) swap this for the
 * official primitive.
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
