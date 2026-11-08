import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The one tile shape used everywhere. */
export function Tile({
  children,
  className,
  as: As = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "button";
} & React.HTMLAttributes<HTMLElement> & { type?: "button" }) {
  return (
    <As
      className={cn(
        "glass text-left",
        As === "button" && "transition-colors hover:bg-white/80 focus-visible:outline-2",
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}
