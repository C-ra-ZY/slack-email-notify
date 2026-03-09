// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";

const METHODS: ConsoleMethod[] = ["debug", "error", "info", "log", "warn"];

let installed = false;

export function installTimestampedConsole(): void {
  if (installed) return;
  installed = true;

  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      original(`[${new Date().toISOString()}]`, ...args);
    }) as typeof console[typeof method];
  }
}
