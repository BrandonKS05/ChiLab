(() => {
  "use strict";

  if (window.__chilabFrontendV4) {
    return;
  }
  if (!location.hostname.endsWith("overleaf.com")) {
    return;
  }

  const chilab = window.__chilabContent;
  if (!chilab?.ChiLabApp) {
    console.error("chilab bootstrap failed: ChiLabApp module missing.");
    return;
  }

  window.__chilabFrontendV4 = true;
  const app = new chilab.ChiLabApp();
  app.init();
  window.__chilabApp = app;
  window.__chilabDebug = {
    getChunkTree: () => app.chunkTree,
    getLeafChunks: () => (app.chunkTree ? app.chunkTree.leafChunks : []),
    getActiveChunkId: () => app.activeChunkId,
    getActiveChunk: () => {
      if (!app.chunkTree || !app.activeChunkId) {
        return null;
      }
      return app.chunkTree.chunkById.get(app.activeChunkId) || null;
    },
  };

  window.__chilabDestroy = () => {
    app.destroy();
    delete window.__chilabDebug;
    delete window.__chilabApp;
    delete window.__chilabFrontendV4;
  };
})();
