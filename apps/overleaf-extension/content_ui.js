(() => {
  "use strict";

  const chilab = window.__chilabContent || (window.__chilabContent = {});
  const { MAX_HIGHLIGHT_RECTS, ensureArray, normalizeSeverity, clamp } = chilab;

  function formatInferenceDuration(valueMs) {
    const ms = Number(valueMs);
    if (!Number.isFinite(ms)) {
      return "--";
    }
    if (ms > 1000) {
      const seconds = ms / 1000;
      return `${seconds.toFixed(2).replace(/\.0+$/, "")} s`;
    }
    return `${Math.round(ms)} ms`;
  }

  function deriveReplacementFromSuggestion(suggestionText, targetText) {
    const suggestion = String(suggestionText || "").trim();
    const target = String(targetText || "").trim();
    if (!suggestion || !target) {
      return "";
    }

    const cleaned = suggestion
      .replace(/^suggested fix:\s*/i, "")
      .replace(/^try this rewrite(?: next)?:\s*/i, "")
      .trim();
    const patterns = [
      /^did you mean\s+(.+?)\?\s*$/i,
      /^replace with\s+(.+?)\.?\s*$/i,
      /^use\s+(.+?)\s+instead\.?\s*$/i,
      /^rewrite as\s+(.+?)\.?\s*$/i,
    ];
    let candidate = "";
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match && match[1]) {
        candidate = String(match[1]).trim();
        break;
      }
    }
    if (!candidate) {
      return "";
    }

    candidate = candidate
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (!candidate || candidate === target || candidate.length > 260) {
      return "";
    }
    return candidate;
  }

class ChiLabOverlay {
  constructor() {
    this.layer = document.createElement("div");
    this.layer.className = "chilab-highlight-layer";
    document.body.appendChild(this.layer);
    this.rectIssueMap = [];
  }

  clear() {
    this.layer.replaceChildren();
    this.rectIssueMap = [];
  }

  render(adapter, issues, snapshot) {
    this.clear();
    if (!adapter || !adapter.supportsInlineHighlights) {
      return;
    }

    const renderedRects = [];
    const sourceText = snapshot.sourceText;

    for (const issue of issues) {
      if (renderedRects.length >= MAX_HIGHLIGHT_RECTS) {
        break;
      }

      const ranges = this.resolveRanges(issue, snapshot, sourceText, adapter);
      for (const [start, end] of ranges) {
        const rects = adapter.getClientRectsForRange(start, end, adapter.getVisibleTextSnapshot());
        for (const rect of rects) {
          if (renderedRects.length >= MAX_HIGHLIGHT_RECTS) {
            break;
          }
          const marker = document.createElement("div");
          marker.className = `chilab-highlight chilab-highlight--${issue.severity}`;
          marker.style.left = `${rect.left}px`;
          marker.style.top = `${rect.top}px`;
          marker.style.width = `${rect.width}px`;
          marker.style.height = `${Math.max(rect.height, 15)}px`;
          this.layer.appendChild(marker);
          renderedRects.push({
            issue,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
          });
        }
      }
    }

    this.rectIssueMap = renderedRects;
  }

  resolveRangeFromDom(issue, snapshot, _sourceText, adapter) {
    if (!adapter || typeof adapter.getVisibleTextSnapshot !== "function") {
      return null;
    }
    const target = String(issue?.targetText || "").trim();
    if (!target) {
      return null;
    }
    const visible = adapter.getVisibleTextSnapshot();
    const visibleText = String(visible?.text || "");
    if (!visibleText) {
      return null;
    }

    const candidates = [];
    let cursor = visibleText.indexOf(target);
    while (cursor !== -1) {
      candidates.push(cursor);
      if (candidates.length >= 32) {
        break;
      }
      cursor = visibleText.indexOf(target, cursor + target.length);
    }
    if (candidates.length === 0) {
      return null;
    }

    const expectedGlobalStart = Number.isInteger(issue?.start)
      ? ((Number.isInteger(snapshot?.scopeStart) ? snapshot.scopeStart : 0) + issue.start)
      : null;
    const sentenceText = String(issue?.sentenceText || "").trim();
    const sentenceStarts = [];
    if (sentenceText) {
      let sentenceCursor = visibleText.indexOf(sentenceText);
      while (sentenceCursor !== -1) {
        sentenceStarts.push(sentenceCursor);
        if (sentenceStarts.length >= 12) {
          break;
        }
        sentenceCursor = visibleText.indexOf(sentenceText, sentenceCursor + sentenceText.length);
      }
    }
    let sentenceWindow = null;
    if (sentenceStarts.length > 0) {
      let bestSentenceStart = sentenceStarts[0];
      if (Number.isInteger(expectedGlobalStart)) {
        let bestDistance = Math.abs(sentenceStarts[0] - expectedGlobalStart);
        for (let i = 1; i < sentenceStarts.length; i += 1) {
          const distance = Math.abs(sentenceStarts[i] - expectedGlobalStart);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestSentenceStart = sentenceStarts[i];
          }
        }
      }
      sentenceWindow = [bestSentenceStart, bestSentenceStart + sentenceText.length];
    }

    let bestIndex = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const start of candidates) {
      let score = 0;
      if (Number.isInteger(expectedGlobalStart)) {
        score += Math.abs(start - expectedGlobalStart);
      }
      if (sentenceWindow && start >= sentenceWindow[0] && start + target.length <= sentenceWindow[1]) {
        score -= 100000;
      }
      if (score < bestScore) {
        bestScore = score;
        bestIndex = start;
      }
    }

    return [bestIndex, bestIndex + target.length];
  }

  resolveRanges(issue, snapshot, sourceText, adapter = null) {
    const ranges = [];
    if (Number.isInteger(issue.start) && Number.isInteger(issue.end)) {
      const globalStart = snapshot.scopeStart + issue.start;
      const globalEnd = snapshot.scopeStart + issue.end;
      const target = String(issue?.targetText || "").trim();
      const spanText = sourceText.slice(globalStart, globalEnd);
      if (
        target &&
        globalEnd > globalStart &&
        spanText !== target &&
        !spanText.includes(target)
      ) {
        const domRange = this.resolveRangeFromDom(issue, snapshot, sourceText, adapter);
        if (domRange) {
          ranges.push(domRange);
          return ranges;
        }
      }
      ranges.push([globalStart, globalEnd]);
      return ranges;
    }

    if (!issue.targetText) {
      return ranges;
    }

    const target = issue.targetText.trim();
    if (!target) {
      return ranges;
    }

    const domRange = this.resolveRangeFromDom(issue, snapshot, sourceText, adapter);
    if (domRange) {
      ranges.push(domRange);
      return ranges;
    }

    let index = sourceText.indexOf(target, snapshot.scopeStart);
    while (index !== -1) {
      if (index > snapshot.scopeEnd) {
        break;
      }
      ranges.push([index, index + target.length]);
      if (ranges.length >= 3) {
        break;
      }
      index = sourceText.indexOf(target, index + target.length);
    }

    return ranges;
  }

  findIssueAtPoint(clientX, clientY) {
    for (const row of this.rectIssueMap) {
      const rect = row.rect;
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return row;
      }
    }
    return null;
  }

  remove() {
    this.layer.remove();
  }
}

class ChiLabPopover {
  constructor(onApply, onIgnore) {
    this.onApply = onApply;
    this.onIgnore = onIgnore;
    this.element = null;
    this.currentIssue = null;

    this.boundOutside = this.handleOutside.bind(this);
    this.boundEsc = this.handleEsc.bind(this);
  }

  open(issue, anchorRect) {
    this.close();
    this.currentIssue = issue;

    const element = document.createElement("div");
    element.className = "chilab-suggestion-popover";

    const title = document.createElement("p");
    title.className = "chilab-suggestion-title";
    title.textContent = issue.message;
    element.appendChild(title);

    const list = document.createElement("div");
    list.className = "chilab-suggestion-list";

    const suggestionText = String(issue?.suggestion || issue?.suggestedFix || "").trim();
    let resolvedReplacement = String(issue?.replacement || "").trim();
    if (!resolvedReplacement && suggestionText && issue?.targetText) {
      resolvedReplacement = deriveReplacementFromSuggestion(suggestionText, issue.targetText);
    }
    const applyPayload = () => {
      this.onApply({
        ...issue,
        replacement: resolvedReplacement,
      });
      this.close();
    };
    const derivedFromSuggestion = suggestionText && issue?.targetText
      ? deriveReplacementFromSuggestion(suggestionText, issue.targetText)
      : "";
    const isSameFix = resolvedReplacement && suggestionText && (
      suggestionText === resolvedReplacement ||
      suggestionText.replace(/^suggested fix:\s*/i, "").trim() === resolvedReplacement ||
      (derivedFromSuggestion && derivedFromSuggestion === resolvedReplacement)
    );
    if (resolvedReplacement) {
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "chilab-suggestion-option chilab-suggestion-option--clickable";
      const strong = document.createElement("strong");
      strong.textContent = isSameFix ? "Apply" : "Apply replacement";
      const span = document.createElement("span");
      span.className = "chilab-suggestion-fix-text";
      span.textContent = resolvedReplacement;
      applyBtn.append(strong, span);
      applyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        applyPayload();
      });
      list.appendChild(applyBtn);
    }
    if (suggestionText && !isSameFix) {
      const note = document.createElement("div");
      note.className = "chilab-suggestion-note";
      const label = document.createElement("strong");
      label.textContent = "Suggested fix";
      const body = document.createElement("span");
      body.textContent = suggestionText;
      note.append(label, body);
      list.appendChild(note);
    }

    const ignoreBtn = document.createElement("button");
    ignoreBtn.type = "button";
    ignoreBtn.className = "chilab-suggestion-option";
    ignoreBtn.innerHTML = "<strong>Ignore this issue</strong><span>Hide this rule hit in this project.</span>";
    ignoreBtn.addEventListener("click", (event) => {
      event.preventDefault();
      this.onIgnore(issue);
      this.close();
    });
    list.appendChild(ignoreBtn);

    element.appendChild(list);
    document.body.appendChild(element);
    this.element = element;
    this.position(anchorRect);

    document.addEventListener("pointerdown", this.boundOutside, true);
    document.addEventListener("keydown", this.boundEsc, true);
    window.addEventListener("resize", this.boundEsc);
    window.addEventListener("scroll", this.boundEsc, true);
  }

  position(anchorRect) {
    if (!this.element || !anchorRect) {
      return;
    }

    const margin = 10;
    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;

    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    if (left + width > window.innerWidth - margin) {
      left = window.innerWidth - width - margin;
    }
    if (left < margin) {
      left = margin;
    }

    if (top + height > window.innerHeight - margin) {
      top = anchorRect.top - height - 8;
    }
    if (top < margin) {
      top = margin;
    }

    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  handleOutside(event) {
    if (!this.element) {
      return;
    }
    if (event?.__chilabKeepPopover) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(".chilab-suggestion-popover")) {
      return;
    }
    this.close();
  }

  handleEsc(event) {
    if (event instanceof KeyboardEvent && event.key !== "Escape") {
      return;
    }
    this.close();
  }

  close() {
    if (!this.element) {
      this.currentIssue = null;
      return;
    }

    this.element.remove();
    this.element = null;
    this.currentIssue = null;

    document.removeEventListener("pointerdown", this.boundOutside, true);
    document.removeEventListener("keydown", this.boundEsc, true);
    window.removeEventListener("resize", this.boundEsc);
    window.removeEventListener("scroll", this.boundEsc, true);
  }
}

class ChiLabPanel {
  constructor(handlers) {
    this.handlers = handlers;
    this.root = document.createElement("aside");
    this.root.className = "chilab-shell";
    this.root.setAttribute("role", "complementary");
    this.root.setAttribute("aria-label", "chilab math checker panel");

    this.root.innerHTML = `
      <header class="chilab-header">
        <div class="chilab-header-top">
          <div class="chilab-brand">
            <img class="chilab-brand-logo" src="${chrome.runtime.getURL("assets/chilab-black-white-2048.png")}" alt="chilab" />
            <div>
              <h2>chilab</h2>
              <p>Grammarly for Math</p>
            </div>
          </div>
          <div class="chilab-top-right">
            <div id="chilab-global-pill" class="chilab-global-pill">
              <span id="chilab-global-dot" class="chilab-global-dot"></span>
              <span id="chilab-global-text">global · idle</span>
            </div>
            <button type="button" id="chilab-collapse-btn" class="chilab-icon-btn">Hide</button>
          </div>
        </div>
        <div class="chilab-status-row">
          <div class="chilab-status">
            <span id="chilab-status-dot" class="chilab-status-dot"></span>
            <span id="chilab-status-text">Idle</span>
          </div>
          <div id="chilab-inference-text" class="chilab-inference">inference --</div>
        </div>
      </header>
      <section class="chilab-toolbar">
        <div class="chilab-field">
          <label for="chilab-scope-select">Scope</label>
          <select id="chilab-scope-select">
            <option value="selection">Selection</option>
            <option value="paragraph">Paragraph</option>
            <option value="document">Document</option>
          </select>
        </div>
        <div class="chilab-field">
          <label>Mode</label>
          <div class="chilab-mode-toggle" role="tablist" aria-label="chilab mode">
            <button type="button" class="chilab-mode-btn" data-mode="fast">fast</button>
            <button type="button" class="chilab-mode-btn" data-mode="accurate">accurate</button>
            <button type="button" class="chilab-mode-btn" data-mode="auto">auto</button>
          </div>
        </div>
        <div class="chilab-toolbar-actions">
          <button type="button" id="chilab-run-btn" class="chilab-icon-btn">Check</button>
          <button type="button" id="chilab-settings-btn" class="chilab-icon-btn">Settings</button>
        </div>
      </section>
      <div class="chilab-content">
        <section class="chilab-card">
          <div class="chilab-card-header">
            <h3>Document Health</h3>
            <span id="chilab-sentence-stats" class="chilab-card-meta">0 cached · 0 pending</span>
          </div>
          <div class="chilab-health">
            <div class="chilab-health-meter"><span id="chilab-health-fill"></span></div>
            <span id="chilab-health-label">100</span>
          </div>
          <div class="chilab-item-actions chilab-item-actions--top">
            <button type="button" id="chilab-regenerate-btn" class="chilab-btn">Refresh</button>
            <button type="button" id="chilab-next-btn" class="chilab-btn">Next</button>
            <button type="button" id="chilab-prev-btn" class="chilab-btn">Prev</button>
          </div>
        </section>
        <section class="chilab-card">
          <div class="chilab-card-header">
            <h3>Activity & History</h3>
            <div class="chilab-item-actions chilab-item-actions--inline">
              <button type="button" id="chilab-undo-btn" class="chilab-btn">Undo Last</button>
              <button type="button" id="chilab-clear-history-btn" class="chilab-btn">Clear</button>
            </div>
          </div>
          <ul id="chilab-activity" class="chilab-list"></ul>
          <p id="chilab-activity-empty" class="chilab-empty">No activity yet.</p>
        </section>
        <section class="chilab-card">
          <div class="chilab-card-header">
            <h3>Live Feedback</h3>
            <span id="chilab-feedback-count" class="chilab-card-meta">0</span>
          </div>
          <ul id="chilab-issues" class="chilab-list"></ul>
          <p id="chilab-issues-empty" class="chilab-empty">No issues found.</p>
        </section>
        <section id="chilab-settings-card" class="chilab-card" style="display:none">
          <div class="chilab-card-header">
            <h3>Autocomplete Settings</h3>
          </div>
          <div class="chilab-settings">
            <div class="chilab-field">
              <label for="chilab-timeout">Timeout (ms)</label>
              <input id="chilab-timeout" type="number" min="2000" step="500" />
            </div>
            <div class="chilab-field">
              <label for="chilab-retries">Retries</label>
              <input id="chilab-retries" type="number" min="0" max="4" step="1" />
            </div>
            <div class="chilab-settings-row">
              <span>Enable autocomplete</span>
              <input id="chilab-autocomplete-enabled" type="checkbox" />
            </div>
            <div class="chilab-settings-row">
              <span>Auto-analyze document</span>
              <input id="chilab-auto-analyze-document" type="checkbox" />
            </div>
            <div class="chilab-settings-row">
              <span>Check on typing</span>
              <input id="chilab-check-on-type" type="checkbox" />
            </div>
            <div class="chilab-settings-row">
              <span>Show Top-K autocomplete list</span>
              <input id="chilab-autocomplete-topk" type="checkbox" />
            </div>
            <div class="chilab-settings-row">
              <span>Manual trigger only (Cmd+Shift+M)</span>
              <input id="chilab-autocomplete-manual" type="checkbox" />
            </div>
            <div class="chilab-field">
              <label for="chilab-notation">Notation strictness</label>
              <select id="chilab-notation">
                <option value="relaxed">Relaxed</option>
                <option value="balanced">Balanced</option>
                <option value="strict">Strict</option>
              </select>
            </div>
            <button type="button" id="chilab-save-settings" class="chilab-btn chilab-btn--primary">Save Settings</button>
          </div>
          <ul class="chilab-shortcuts">
            <li><code>⌥⇧N</code> ➡️ next issue</li>
            <li><code>⌥⇧P</code> ⬅️ previous issue</li>
            <li><code>⌘↩</code> ⚡ run check now</li>
            <li><code>⌥⇧R</code> 🔄 refresh checker</li>
            <li><code>⌥⇧H</code> 🧹 clear activity history</li>
            <li><code>⌥⇧M</code> ✨ request autocomplete</li>
            <li><code>⌥⇧A</code> ✅ apply focused replacement</li>
            <li><code>⌥⇧U</code> ↩️ undo last action</li>
          </ul>
        </section>
      </div>
    `;

    document.body.append(this.root);
    this.fab = document.createElement("button");
    this.fab.type = "button";
    this.fab.className = "chilab-fab";
    this.fab.setAttribute("aria-label", "Open chilab panel");
    this.fab.innerHTML = `
      <img src="${chrome.runtime.getURL("assets/chilab-black-white-2048.png")}" alt="" />
    `;
    document.body.append(this.fab);
    this.popupMirror = document.createElement("aside");
    this.popupMirror.className = "chilab-popup-mirror";
    this.popupMirror.setAttribute("aria-hidden", "true");
    this.popupMirror.innerHTML = `
      <iframe
        class="chilab-popup-mirror-frame"
        src="${chrome.runtime.getURL("popup.html?embedded=1")}"
        title="chilab popup mirror"
      ></iframe>
    `;
    document.body.append(this.popupMirror);
    this.isPopupOpen = false;

    this.refs = {
      statusDot: this.root.querySelector("#chilab-status-dot"),
      statusText: this.root.querySelector("#chilab-status-text"),
      globalDot: this.root.querySelector("#chilab-global-dot"),
      globalText: this.root.querySelector("#chilab-global-text"),
      globalPill: this.root.querySelector("#chilab-global-pill"),
      inferenceText: this.root.querySelector("#chilab-inference-text"),
      sentenceStats: this.root.querySelector("#chilab-sentence-stats"),
      feedbackCount: this.root.querySelector("#chilab-feedback-count"),
      scopeSelect: this.root.querySelector("#chilab-scope-select"),
      modeToggle: this.root.querySelector(".chilab-mode-toggle"),
      modeButtons: Array.from(this.root.querySelectorAll(".chilab-mode-btn")),
      healthFill: this.root.querySelector("#chilab-health-fill"),
      healthLabel: this.root.querySelector("#chilab-health-label"),
      activity: this.root.querySelector("#chilab-activity"),
      activityEmpty: this.root.querySelector("#chilab-activity-empty"),
      issues: this.root.querySelector("#chilab-issues"),
      issuesEmpty: this.root.querySelector("#chilab-issues-empty"),
      runBtn: this.root.querySelector("#chilab-run-btn"),
      regenerateBtn: this.root.querySelector("#chilab-regenerate-btn"),
      nextBtn: this.root.querySelector("#chilab-next-btn"),
      prevBtn: this.root.querySelector("#chilab-prev-btn"),
      undoBtn: this.root.querySelector("#chilab-undo-btn"),
      clearHistoryBtn: this.root.querySelector("#chilab-clear-history-btn"),
      settingsBtn: this.root.querySelector("#chilab-settings-btn"),
      collapseBtn: this.root.querySelector("#chilab-collapse-btn"),
      settingsCard: this.root.querySelector("#chilab-settings-card"),
      timeout: this.root.querySelector("#chilab-timeout"),
      retries: this.root.querySelector("#chilab-retries"),
      autocompleteEnabled: this.root.querySelector("#chilab-autocomplete-enabled"),
      autoAnalyzeDocument: this.root.querySelector("#chilab-auto-analyze-document"),
      checkOnType: this.root.querySelector("#chilab-check-on-type"),
      autocompleteTopK: this.root.querySelector("#chilab-autocomplete-topk"),
      autocompleteManual: this.root.querySelector("#chilab-autocomplete-manual"),
      notation: this.root.querySelector("#chilab-notation"),
      saveSettings: this.root.querySelector("#chilab-save-settings"),
    };

    this.isSettingsOpen = false;
    this.bindEvents();
    this.setOpen(false);
  }

  bindEvents() {
    this.refs.collapseBtn.addEventListener("click", () => this.handlers.onTogglePanel?.(false));
    this.fab.addEventListener("click", () => this.handlers.onTogglePanel?.(!this.isPopupOpen));
    this.refs.runBtn.addEventListener("click", () => this.handlers.onRunNow());
    this.refs.regenerateBtn.addEventListener("click", () => this.handlers.onRegenerate());
    this.refs.undoBtn.addEventListener("click", () => this.handlers.onUndoLast());
    this.refs.clearHistoryBtn.addEventListener("click", () => this.handlers.onClearHistory());
    this.refs.nextBtn.addEventListener("click", () => this.handlers.onNextIssue());
    this.refs.prevBtn.addEventListener("click", () => this.handlers.onPrevIssue());

    this.refs.scopeSelect.addEventListener("change", () => {
      this.handlers.onScopeChange(this.refs.scopeSelect.value);
    });

    for (const button of this.refs.modeButtons) {
      button.addEventListener("click", () => {
        this.handlers.onModeChange(button.dataset.mode || "auto");
      });
    }

    this.refs.settingsBtn.addEventListener("click", () => {
      this.isSettingsOpen = !this.isSettingsOpen;
      this.refs.settingsCard.style.display = this.isSettingsOpen ? "block" : "none";
    });

    this.refs.saveSettings.addEventListener("click", () => {
      this.handlers.onSaveSettings({
        requestTimeoutMs: Number(this.refs.timeout.value),
        retries: Number(this.refs.retries.value),
        autocompleteEnabled: this.refs.autocompleteEnabled.checked,
        autoAnalyzeDocument: this.refs.autoAnalyzeDocument.checked,
        checkOnType: this.refs.checkOnType.checked,
        autocompleteShowTopK: this.refs.autocompleteTopK.checked,
        autocompleteManualTrigger: this.refs.autocompleteManual.checked,
        notationStrictness: this.refs.notation.value,
      });
    });

    this.refs.issues.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const item = target.closest(".chilab-item");
      if (!item) {
        return;
      }

      const index = Number(item.getAttribute("data-issue-index"));
      if (!Number.isFinite(index)) {
        return;
      }

      if (target.closest("[data-action='apply']")) {
        this.handlers.onApplyIssue(index);
        return;
      }

      if (target.closest("[data-action='ignore']")) {
        this.handlers.onIgnoreIssue(index);
        return;
      }

      this.handlers.onFocusIssue(index);
    });
  }

  setOpen(open) {
    this.isPopupOpen = !!open;
    // Keep the legacy shell hidden; the mirror iframe shows the same UI as the toolbar popup.
    this.root.classList.add("is-collapsed");
    this.popupMirror.classList.toggle("is-open", this.isPopupOpen);
    this.popupMirror.setAttribute("aria-hidden", this.isPopupOpen ? "false" : "true");
    this.fab.setAttribute("aria-expanded", this.isPopupOpen ? "true" : "false");
  }

  setTheme(_theme) {
    this.root.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-chilab-theme", "light");
  }

  setGlobalState(state, text) {
    this.refs.globalPill.classList.remove("is-analyzing", "is-ready", "is-error", "is-offline");
    if (state === "analyzing") {
      this.refs.globalPill.classList.add("is-analyzing");
    } else if (state === "error") {
      this.refs.globalPill.classList.add("is-error");
    } else if (state === "offline") {
      this.refs.globalPill.classList.add("is-offline");
    } else {
      this.refs.globalPill.classList.add("is-ready");
    }
    this.refs.globalText.textContent = text;
  }

  setStatus(phase, message) {
    const dot = this.refs.statusDot;
    dot.classList.remove("is-analyzing", "is-success", "is-error");
    if (phase === "analyzing") {
      dot.classList.add("is-analyzing");
    } else if (phase === "success") {
      dot.classList.add("is-success");
    } else if (phase === "error") {
      dot.classList.add("is-error");
    }
    this.refs.statusText.textContent = message;
  }

  setInferenceTime(lastMs, pendingCount = 0) {
    const msLabel = formatInferenceDuration(lastMs);
    const queueLabel = pendingCount > 0 ? ` · ${pendingCount} queued` : "";
    this.refs.inferenceText.textContent = `inference ${msLabel}${queueLabel}`;
  }

  setMode(mode) {
    const indexByMode = { fast: 0, accurate: 1, auto: 2 };
    const index = indexByMode[mode] ?? 2;
    this.refs.modeToggle.style.setProperty("--chilab-mode-index", String(index));
    for (const button of this.refs.modeButtons) {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    }
  }

  setScope(scope) {
    this.refs.scopeSelect.value = scope;
  }

  setHealth(score) {
    const clamped = clamp(Math.round(score), 0, 100);
    this.refs.healthFill.style.width = `${clamped}%`;
    this.refs.healthLabel.textContent = `${clamped}`;
  }

  setSentenceStats(cachedCount, pendingCount) {
    this.refs.sentenceStats.textContent = `${cachedCount} cached · ${pendingCount} pending`;
  }

  setActivity(entries, canUndo) {
    const list = this.refs.activity;
    list.replaceChildren();
    const items = ensureArray(entries);

    for (const entry of items) {
      const li = document.createElement("li");
      li.className = "chilab-activity-item";
      li.setAttribute("data-level", entry.level || "info");
      li.innerHTML = `<strong>${entry.message}</strong><p>${entry.timeLabel || ""}</p>`;
      list.appendChild(li);
    }

    this.refs.activityEmpty.style.display = items.length > 0 ? "none" : "block";
    this.refs.undoBtn.disabled = !canUndo;
  }

  setIssues(issues, focusedIndex) {
    const list = this.refs.issues;
    list.replaceChildren();
    const items = ensureArray(issues);
    this.refs.feedbackCount.textContent = String(items.length);

    for (let i = 0; i < items.length; i += 1) {
      const issue = items[i];
      const li = document.createElement("li");
      li.className = "chilab-item";
      li.setAttribute("data-severity", normalizeSeverity(issue.severity));
      li.setAttribute("data-issue-index", String(i));
      if (i === focusedIndex) {
        li.style.outline = "1px solid currentColor";
      }

      const targetLabel = issue.targetText ? ` · ${issue.targetText}` : "";
      li.innerHTML = `<strong>${issue.category || "issue"}${targetLabel}</strong><p>${issue.message || "Review this issue."}</p>`;

      const actionRow = document.createElement("div");
      actionRow.className = "chilab-item-actions";

      if (issue.replacement) {
        const fixBtn = document.createElement("button");
        fixBtn.type = "button";
        fixBtn.className = "chilab-btn chilab-btn-fix-text";
        fixBtn.setAttribute("data-action", "apply");
        fixBtn.textContent = issue.replacement;
        fixBtn.title = "Click to apply this fix";
        actionRow.appendChild(fixBtn);
      }

      const ignoreBtn = document.createElement("button");
      ignoreBtn.type = "button";
      ignoreBtn.className = "chilab-btn";
      ignoreBtn.setAttribute("data-action", "ignore");
      ignoreBtn.textContent = "Ignore";
      actionRow.appendChild(ignoreBtn);

      li.appendChild(actionRow);
      list.appendChild(li);
    }

    this.refs.issuesEmpty.style.display = items.length > 0 ? "none" : "block";
  }

  setSettings(settings) {
    this.refs.timeout.value = String(settings.requestTimeoutMs);
    this.refs.retries.value = String(settings.retries);
    this.refs.autocompleteEnabled.checked = settings.autocompleteEnabled !== false;
    this.refs.autoAnalyzeDocument.checked = settings.autoAnalyzeDocument !== false;
    this.refs.checkOnType.checked = !!settings.checkOnType;
    this.refs.autocompleteTopK.checked = !!settings.autocompleteShowTopK;
    this.refs.autocompleteManual.checked = !!settings.autocompleteManualTrigger;
    this.refs.notation.value = settings.notationStrictness;
    this.setMode(settings.mode);
    this.setScope(settings.scope);
    this.setTheme(settings.theme);
  }

  scrollIssueIntoView(index) {
    const target = this.refs.issues.querySelector(`[data-issue-index='${index}']`);
    if (target) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  remove() {
    this.fab.remove();
    this.popupMirror.remove();
    this.root.remove();
  }
}

  Object.assign(chilab, {
    ChiLabOverlay,
    ChiLabPopover,
    ChiLabPanel,
  });
})();
