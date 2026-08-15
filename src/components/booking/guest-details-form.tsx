"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { GuestDetails } from "@/lib/types";

interface GuestDetailsFormProps {
  formId: string;
  defaultValues?: Partial<GuestDetails>;
  onSubmit: (details: GuestDetails) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function GuestDetailsForm({
  formId,
  defaultValues,
  onSubmit,
}: GuestDetailsFormProps) {
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [email, setEmail] = useState(defaultValues?.email ?? "");
  const [notes, setNotes] = useState(defaultValues?.notes ?? "");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (name.trim().length < 2) nextErrors.name = "Please enter your name.";
    if (!EMAIL_RE.test(email.trim()))
      nextErrors.email = "Please enter a valid email address.";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    onSubmit({
      name: name.trim(),
      email: email.trim(),
      notes: notes.trim() || undefined,
    });
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="grid gap-5" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="guest-name">
          Full name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="guest-name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "guest-name-error" : undefined}
          placeholder="Jamie Rivera"
        />
        {errors.name && (
          <p id="guest-name-error" className="text-xs text-destructive">
            {errors.name}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="guest-email">
          Email <span className="text-destructive">*</span>
        </Label>
        <Input
          id="guest-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!errors.email}
          aria-describedby={
            errors.email ? "guest-email-error" : "guest-email-hint"
          }
          placeholder="you@example.com"
        />
        {errors.email ? (
          <p id="guest-email-error" className="text-xs text-destructive">
            {errors.email}
          </p>
        ) : (
          <p id="guest-email-hint" className="text-xs text-muted-foreground">
            Your confirmation and calendar invite are sent here.
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="guest-notes">Anything we should know? (optional)</Label>
        <Textarea
          id="guest-notes"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Share anything that would help us prepare for your visit."
          rows={3}
        />
      </div>
    </form>
  );
}
