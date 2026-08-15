import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Service } from "@/lib/types";

/**
 * Shared create/edit form for a service. Server-rendered — the only client
 * behavior is native HTML5 validation (required/min/step), which mirrors the DB
 * checks. `action` is a server action; for edits, bind the service id first.
 */
export function ServiceForm({
  action,
  service,
  currency,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  service?: Service;
  currency: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`name-${service?.id ?? "new"}`}>Name</Label>
          <Input
            id={`name-${service?.id ?? "new"}`}
            name="name"
            required
            defaultValue={service?.name}
            placeholder="e.g. Standard Session"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`description-${service?.id ?? "new"}`}>
            Description
          </Label>
          <Textarea
            id={`description-${service?.id ?? "new"}`}
            name="description"
            rows={2}
            defaultValue={service?.description}
            placeholder="A short, friendly summary guests will see."
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`duration-${service?.id ?? "new"}`}>
            Duration (minutes)
          </Label>
          <Input
            id={`duration-${service?.id ?? "new"}`}
            name="durationMinutes"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={service?.durationMinutes}
            placeholder="50"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`price-${service?.id ?? "new"}`}>
            Price ({currency})
          </Label>
          <Input
            id={`price-${service?.id ?? "new"}`}
            name="price"
            type="number"
            min={0}
            step="0.01"
            required
            defaultValue={
              service ? (service.priceCents / 100).toString() : undefined
            }
            placeholder="150"
          />
        </div>
      </div>

      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
