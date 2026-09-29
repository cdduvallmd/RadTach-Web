// Version check on Start Session: is a newer build deployed than the one this
// tab is running? Reads /version.json (emitted by the build, see vite.config.ts).
// Never throws and never blocks a session — any failure returns null.

import { BUILD_ID } from '../buildId';

const TIMEOUT_MS = 3000;

async function getDeployedBuildId(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { buildId?: unknown };
    return typeof data.buildId === 'string' ? data.buildId : null;
  } catch {
    // Offline, timeout, or not JSON (dev server returns the app shell).
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the deployed build ID when it differs from this tab's, else null.
export async function checkForNewerBuild(): Promise<string | null> {
  const deployed = await getDeployedBuildId();
  return deployed && deployed !== BUILD_ID ? deployed : null;
}
