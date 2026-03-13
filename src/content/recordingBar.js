const BAR_ID = "__automation-recorder-bar";
const MINI_ID = "__automation-recorder-mini";
const RECORDER_UI_ATTR = "data-automation-recorder-ui";

// ── Shared Styles (injected once) ──
function injectStyles() {
  if (document.getElementById("__automation-recorder-styles")) return;

  const style = document.createElement("style");
  style.id = "__automation-recorder-styles";
  style.setAttribute(RECORDER_UI_ATTR, "true");
  style.textContent = `
    @keyframes __ar-slideDown {
      from { transform: translateY(-100%); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
    @keyframes __ar-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }
    @keyframes __ar-bounce {
      0%, 100% { transform: translateY(0); }
      50%      { transform: translateY(-4px); }
    }
    @keyframes __ar-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.25; }
    }

    #${BAR_ID} *,
    #${MINI_ID} * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    #${BAR_ID} button:focus,
    #${MINI_ID}:focus {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}

// ── Remove all bars ──
export function removeBar() {
  const bar = document.getElementById(BAR_ID);
  if (bar) bar.remove();

  const mini = document.getElementById(MINI_ID);
  if (mini) mini.remove();

  // Reset body margin
  document.body.style.transition = "margin-top 0.3s ease-out";
  document.body.style.marginTop = "";
}

// ── Video Prompt Bar (orange — "click extension icon") ──
export function showVideoPromptBar() {
  removeBar();
  injectStyles();

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.setAttribute(RECORDER_UI_ATTR, "true");
  bar.innerHTML = `
    <div style="
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 2147483647;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 10px 20px;
      font-size: 14px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.35);
      animation: __ar-slideDown 0.35s ease-out;
      user-select: none;
    " ${RECORDER_UI_ATTR}="true">

      <!-- Pulsing orange dot -->
      <span style="
        width: 10px; height: 10px;
        border-radius: 50%;
        background: #ff6b35;
        display: inline-block;
        flex-shrink: 0;
        animation: __ar-pulse 1.4s ease-in-out infinite;
      "></span>

      <!-- Message -->
      <span>
        Step recording started — click the
        <strong style="
          background: rgba(255,255,255,0.12);
          padding: 2px 8px;
          border-radius: 4px;
          margin: 0 3px;
          white-space: nowrap;
        ">🧩 extension icon</strong>
        in your toolbar to enable video recording
      </span>

      <!-- Bouncing arrow -->
      <span style="
        font-size: 20px;
        animation: __ar-bounce 0.9s ease-in-out infinite;
      ">↗</span>

      <!-- Skip video button -->
      <button id="${BAR_ID}__skip" style="
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.18);
        color: #ccc;
        padding: 4px 14px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        margin-left: 10px;
        flex-shrink: 0;
        transition: background 0.15s, color 0.15s;
      ">Skip video</button>
    </div>
  `;

  document.documentElement.appendChild(bar);

  // Push page content down
  document.body.style.transition = "margin-top 0.3s ease-out";
  document.body.style.marginTop = "44px";

  // Skip button interactions
  const skipBtn = document.getElementById(`${BAR_ID}__skip`);
  if (skipBtn) {
    skipBtn.addEventListener("mouseenter", () => {
      skipBtn.style.background = "rgba(255,255,255,0.2)";
      skipBtn.style.color = "#fff";
    });
    skipBtn.addEventListener("mouseleave", () => {
      skipBtn.style.background = "rgba(255,255,255,0.08)";
      skipBtn.style.color = "#ccc";
    });
    skipBtn.addEventListener("click", () => {
      // Tell background we're skipping video
      chrome.runtime.sendMessage({ type: "SKIP_VIDEO" });
      showRecordingBar("Recording in progress (no video)");
    });
  }
}

// ── Recording-in-progress Bar (red) ──
export function showRecordingBar(statusText) {
  removeBar();
  injectStyles();

  const text = statusText || "Recording in progress";

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.setAttribute(RECORDER_UI_ATTR, "true");
  bar.innerHTML = `
    <div style="
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 2147483647;
      background: linear-gradient(135deg, #b71c1c 0%, #880e0e 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 8px 20px;
      font-size: 13px;
      box-shadow: 0 2px 14px rgba(0,0,0,0.35);
      animation: __ar-slideDown 0.3s ease-out;
      user-select: none;
    " ${RECORDER_UI_ATTR}="true">

      <!-- Blinking red dot -->
      <span style="
        width: 10px; height: 10px;
        border-radius: 50%;
        background: #ff4444;
        display: inline-block;
        animation: __ar-blink 1s ease-in-out infinite;
        box-shadow: 0 0 8px rgba(255,68,68,0.5);
      "></span>

      <span id="${BAR_ID}__status">${text}</span>

      <!-- Minimize button -->
      <button id="${BAR_ID}__minimize" title="Minimize" style="
        background: none;
        border: none;
        color: rgba(255,255,255,0.55);
        cursor: pointer;
        font-size: 16px;
        padding: 0 6px;
        margin-left: 10px;
        transition: color 0.15s;
      ">✕</button>
    </div>
  `;

  document.documentElement.appendChild(bar);

  document.body.style.transition = "margin-top 0.3s ease-out";
  document.body.style.marginTop = "38px";

  // Minimize button
  const minBtn = document.getElementById(`${BAR_ID}__minimize`);
  if (minBtn) {
    minBtn.addEventListener("mouseenter", () => {
      minBtn.style.color = "#fff";
    });
    minBtn.addEventListener("mouseleave", () => {
      minBtn.style.color = "rgba(255,255,255,0.55)";
    });
    minBtn.addEventListener("click", () => {
      removeBar();
      showMinimizedIndicator();
    });
  }
}

// ── Minimized corner indicator ──
function showMinimizedIndicator() {
  const mini = document.createElement("div");
  mini.id = MINI_ID;
  mini.setAttribute(RECORDER_UI_ATTR, "true");
  mini.tabIndex = 0;
  mini.title = "Recording in progress — click to expand";
  mini.innerHTML = `
    <div style="
      position: fixed;
      top: 10px; right: 10px;
      z-index: 2147483647;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #ff4444;
      box-shadow: 0 0 10px rgba(255,68,68,0.55);
      cursor: pointer;
      animation: __ar-blink 1s ease-in-out infinite;
    "></div>
  `;

  document.documentElement.appendChild(mini);
  document.body.style.marginTop = "";

  mini.addEventListener("click", () => {
    mini.remove();
    showRecordingBar();
  });
}
