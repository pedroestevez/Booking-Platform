import { buildHarness } from "./harness/build";

/** Compiles the harness once before the layout suite runs. */
export default async function globalSetup(): Promise<void> {
  await buildHarness();
}
