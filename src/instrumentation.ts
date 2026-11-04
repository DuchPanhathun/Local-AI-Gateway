// Runs once when the server starts: begins testing the providers (see
// lib/provider-check.ts), so a broken one is held before the first request
// finds it, and not only after somebody opens the console.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startProviderChecks } = await import("./lib/provider-setup");
    startProviderChecks();
  }
}
