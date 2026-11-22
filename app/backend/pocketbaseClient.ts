import PocketBase, { LocalAuthStore } from "pocketbase";

// In production the app is served by PocketBase itself, so the API is on the
// same origin. In development, scripts/start-pocketbase.sh writes
// VITE_POCKETBASE_URL=http://localhost:8090 to .env.development.local.
export const POCKETBASE_URL: string =
  import.meta.env.VITE_POCKETBASE_URL ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:8090");

// Scope the auth store per backend URL so a token for one instance is never
// replayed against another.
const authStore = new LocalAuthStore(`finance_auth_${POCKETBASE_URL}`);

const pb = new PocketBase(POCKETBASE_URL, authStore);
pb.autoCancellation(false);

export default pb;
