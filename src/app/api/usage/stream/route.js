import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";
const MIN_FULL_REFRESH_INTERVAL_MS = 3000;

export async function GET() {
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    keepalive: null,
    send: null,
    sendPending: null,
    cachedStats: null,
    lastFullRefreshAt: 0,
    fullRefreshTimer: null,
    fullRefreshInFlight: false,
    fullRefreshQueued: false,
    refreshFull: null,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const cleanup = () => {
        state.closed = true;
        statsEmitter.off("update", state.send);
        statsEmitter.off("pending", state.sendPending);
        clearInterval(state.keepalive);
        if (state.fullRefreshTimer) {
          clearTimeout(state.fullRefreshTimer);
          state.fullRefreshTimer = null;
        }
      };

      state.refreshFull = async (force = false) => {
        if (state.closed) return;

        if (!force) {
          const elapsed = Date.now() - state.lastFullRefreshAt;
          const waitMs = MIN_FULL_REFRESH_INTERVAL_MS - elapsed;
          if (waitMs > 0) {
            if (!state.fullRefreshTimer) {
              state.fullRefreshTimer = setTimeout(() => {
                state.fullRefreshTimer = null;
                state.refreshFull(true).catch(() => {});
              }, waitMs);
            }
            return;
          }
        }

        if (state.fullRefreshInFlight) {
          state.fullRefreshQueued = true;
          return;
        }

        state.fullRefreshInFlight = true;
        try {
          const stats = await getUsageStats();
          state.cachedStats = stats;
          state.lastFullRefreshAt = Date.now();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          cleanup();
        } finally {
          state.fullRefreshInFlight = false;
          if (state.fullRefreshQueued && !state.closed) {
            state.fullRefreshQueued = false;
            state.refreshFull().catch(() => {});
          }
        }
      };

      // Full stats refresh (heavy) + immediate lightweight push
      state.send = async () => {
        if (state.closed) return;
        try {
          // Push lightweight update immediately so UI reflects changes fast
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
            const quickStats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`));
          }
          // Then schedule throttled full recalc and update cache
          await state.refreshFull();
        } catch {
          cleanup();
        }
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async () => {
        if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          cleanup();
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
      if (state.fullRefreshTimer) {
        clearTimeout(state.fullRefreshTimer);
        state.fullRefreshTimer = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
