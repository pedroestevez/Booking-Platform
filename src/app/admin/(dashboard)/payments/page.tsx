import type { Metadata } from "next";
import { CheckCircle2, CreditCard, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveAdminContext } from "@/lib/admin/auth";
import { getPaymentSettings, refreshAccountStatus } from "@/lib/admin/payments";
import { isStripeConfigured } from "@/lib/stripe/server";
import {
  openDashboardAction,
  refreshStatusAction,
  setPlatformFeeAction,
  startOnboardingAction,
} from "./actions";

export const metadata: Metadata = { title: "Payments" };

interface PageProps {
  searchParams: Promise<{ onboarded?: string; refresh?: string }>;
}

export default async function AdminPaymentsPage({ searchParams }: PageProps) {
  const { tenant } = await resolveAdminContext();
  const sp = await searchParams;

  // Coming back from Stripe onboarding — sync the latest status before render.
  if ((sp.onboarded || sp.refresh) && isStripeConfigured()) {
    try {
      await refreshAccountStatus(tenant.id);
    } catch {
      // Surface nothing here; the page still renders from stored state.
    }
  }

  const settings = await getPaymentSettings(tenant.id);
  const stripeConfigured = isStripeConfigured();
  const connected = Boolean(settings.stripeAccountId);
  const ready = connected && settings.chargesEnabled;
  const feePercent = (settings.platformFeeBps / 100).toString();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your Stripe account to take payment for bookings. Funds go
          straight to you.
        </p>
      </div>

      {!stripeConfigured && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30">
          <CardContent className="py-4 text-sm text-amber-900 dark:text-amber-200">
            Stripe isn&rsquo;t configured on the server yet
            (<code>STRIPE_SECRET_KEY</code>), so connecting won&rsquo;t work until
            an admin sets the keys.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="size-4" />
              Stripe account
            </CardTitle>
            <CardDescription>
              Payments are processed on your own Stripe (Express) account.
            </CardDescription>
          </div>
          {ready ? (
            <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="mr-1 size-3.5" />
              Connected
            </Badge>
          ) : connected ? (
            <Badge variant="muted">Setup incomplete</Badge>
          ) : (
            <Badge variant="muted">Not connected</Badge>
          )}
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!ready && (
            <form action={startOnboardingAction}>
              <Button type="submit" disabled={!stripeConfigured}>
                {connected ? "Finish Stripe setup" : "Connect Stripe"}
              </Button>
            </form>
          )}
          {ready && (
            <form action={openDashboardAction}>
              <Button type="submit" variant="outline">
                Open Stripe dashboard
                <ExternalLink className="size-4" />
              </Button>
            </form>
          )}
          {connected && (
            <form action={refreshStatusAction}>
              <Button type="submit" variant="ghost" disabled={!stripeConfigured}>
                Refresh status
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform fee</CardTitle>
          <CardDescription>
            The platform&rsquo;s share of each booking. Leave at 0% if this tenant
            pays upfront; set a percentage for revenue-share.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={setPlatformFeeAction}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="feePercent">Fee (%)</Label>
              <Input
                id="feePercent"
                name="feePercent"
                type="number"
                min={0}
                max={100}
                step="0.1"
                defaultValue={feePercent}
                className="w-32"
              />
            </div>
            <Button type="submit" variant="outline">
              Save fee
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
