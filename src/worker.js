/*
 * Vokabeltrainer Worker.
 * Static files in ./public are served directly by Workers Static Assets.
 * Only /api/* runs this code (see "run_worker_first" in wrangler.jsonc).
 */
import { onRequest } from "./api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return onRequest({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  }
};
