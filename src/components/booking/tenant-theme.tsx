import type { CSSProperties } from "react";

import type { TenantBranding } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Applies a tenant's white-label accent by setting the `--brand` CSS variable on
 * a wrapper. Every brand-aware token (`--primary`, `--ring`, the mesh) reads
 * from it, so one value re-skins the whole booking flow — no per-tenant CSS,
 * no rebuild.
 */
export function TenantTheme({
  branding,
  className,
  children,
}: {
  branding: TenantBranding;
  className?: string;
  children: React.ReactNode;
}) {
  const style = {
    "--brand": branding.brandColor,
    "--ring": branding.brandColor,
  } as CSSProperties;

  return (
    <div style={style} className={cn(className)}>
      {children}
    </div>
  );
}
