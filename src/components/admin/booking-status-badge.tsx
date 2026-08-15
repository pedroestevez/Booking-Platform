import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BookingStatus } from "@/lib/types";

const STATUS_STYLES: Record<BookingStatus, { label: string; className: string }> =
  {
    pending: {
      label: "Pending",
      className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    },
    confirmed: {
      label: "Confirmed",
      className:
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    },
    completed: {
      label: "Completed",
      className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
    },
    cancelled: {
      label: "Cancelled",
      className: "bg-muted text-muted-foreground line-through",
    },
  };

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return <Badge className={cn("border-transparent", className)}>{label}</Badge>;
}
