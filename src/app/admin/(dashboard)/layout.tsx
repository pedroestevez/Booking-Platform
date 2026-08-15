import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

import { SidebarNav } from "@/components/admin/sidebar-nav";
import { resolveAdminContext } from "@/lib/admin/auth";

/**
 * The authenticated admin shell. Resolving the context here (a) gates every
 * nested page behind sign-in + tenant membership in one place, and (b) gives the
 * chrome the tenant name. The sign-in and no-access routes live OUTSIDE this
 * group, so they don't re-trigger resolution (which would loop).
 */
export default async function AdminDashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { tenant, member } = await resolveAdminContext();

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-border bg-card/40 lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-2 border-b border-border px-5">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
            {tenant.name.charAt(0)}
          </div>
          <span className="truncate text-sm font-semibold">{tenant.name}</span>
        </div>
        <SidebarNav className="flex-1 p-3" />
        <div className="border-t border-border p-3">
          <Link
            href={`/${tenant.slug}`}
            target="_blank"
            className="block rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            View public booking page ↗
          </Link>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="flex h-16 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <div className="lg:hidden">
            <span className="text-sm font-semibold">{tenant.name}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {member.email}
            </span>
            <UserButton />
          </div>
        </header>

        <div className="lg:hidden">
          <SidebarNav className="flex gap-1 overflow-x-auto border-b border-border p-2" />
        </div>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
