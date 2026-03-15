import {
  startRecording,
  stopRecording,
  handleCreateVariable,
} from "./recorder.js";
import {
  showVideoPromptBar,
  showRecordingBar,
  removeBar,
} from "./recordingBar.js";

const DEV_BUTTON_ID = "__automation-recorder-toggle";
const RECORDER_UI_ATTR = "data-automation-recorder-ui";
let devRecording = false;

// ── On load, check if we should already be recording ──
function checkAndResumeRecording() {
  console.log("[INDEX] checkAndResumeRecording()");
  chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" }, (res) => {
    if (chrome.runtime.lastError) {
      console.log(
        "[INDEX] checkAndResumeRecording error:",
        chrome.runtime.lastError.message,
      );
      return;
    }
    console.log(
      "[INDEX] checkAndResumeRecording response:",
      JSON.stringify(res),
    );
    if (!res?.isRecording) return;

    startRecording();

    if (res.hasVideo) {
      showRecordingBar("Recording in progress (with video)");
    } else if (res.videoPending) {
      showVideoPromptBar();
    } else {
      showRecordingBar("Recording in progress (no video)");
    }
  });
}

// ── Dev Button ────────────────────────────────────────────────────────────────
function updateDevButtonState() {
  const btn = document.getElementById(DEV_BUTTON_ID);
  if (!btn) return;
  btn.textContent = devRecording ? "⏹ Stop" : "⏺ Record";
  btn.style.background = devRecording ? "#c62828" : "#1565c0";
}

function createDevButton() {
  if (document.getElementById(DEV_BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = DEV_BUTTON_ID;
  btn.setAttribute(RECORDER_UI_ATTR, "true");
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: 2147483647,
    padding: "8px 18px",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    fontWeight: "bold",
    cursor: "pointer",
    fontSize: "15px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
  });

  btn.addEventListener("click", async () => {
    console.log("[INDEX] Dev button clicked — devRecording:", devRecording);

    if (!devRecording) {
      // ── START ──
      console.log("[INDEX] === STARTING RECORDING ===");
      devRecording = true;
      updateDevButtonState();
      startRecording();
      console.log(
        "[INDEX] startRecording() called, sending DEV_START_RECORDING to background",
      );
      chrome.runtime.sendMessage({ type: "DEV_START_RECORDING" }, (res) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[INDEX] DEV_START_RECORDING error:",
            chrome.runtime.lastError.message,
          );
        } else {
          console.log(
            "[INDEX] DEV_START_RECORDING response:",
            JSON.stringify(res),
          );
        }
      });
      showVideoPromptBar();
    } else {
      // ── STOP ──
      console.log("[INDEX] === STOPPING RECORDING ===");
      devRecording = false;
      updateDevButtonState();
      removeBar();

      console.log("[INDEX] calling await stopRecording()...");
      const result = await stopRecording();
      console.log(
        "[INDEX] stopRecording() resolved — steps:",
        result.steps.length,
        "vars:",
        result.variables.length,
      );

      console.log("[INDEX] sending DEV_STOP_RECORDING to background...");
      chrome.runtime.sendMessage({ type: "DEV_STOP_RECORDING" }, (res) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[INDEX] DEV_STOP_RECORDING error:",
            chrome.runtime.lastError.message,
          );
          return;
        }
        console.log(
          "[INDEX] DEV_STOP_RECORDING response:",
          JSON.stringify(res),
        );
      });
    }
  });

  document.documentElement.appendChild(btn);
  updateDevButtonState();
  console.log("[INDEX] Dev button created");
}

// ── Message Listener (background → content) ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;
  console.log("[INDEX] onMessage received:", type);

  if (type === "START_RECORDING") {
    console.log("[INDEX] handling START_RECORDING from background");
    startRecording();
    showVideoPromptBar();
    sendResponse({ success: true });
    return;
  }

  if (type === "STOP_RECORDING") {
    console.log("[INDEX] handling STOP_RECORDING from background");
    removeBar();
    stopRecording().then((result) => {
      console.log(
        "[INDEX] STOP_RECORDING → stopRecording() resolved — steps:",
        result.steps.length,
      );
      sendResponse({ success: true });
    });
    return true; // async response
  }

  if (type === "CREATE_VARIABLE") {
    handleCreateVariable(msg.kind);
    sendResponse({ success: true });
    return;
  }

  if (type === "VIDEO_STARTED") {
    console.log("[INDEX] VIDEO_STARTED received");
    showRecordingBar("Recording in progress (with video)");
    sendResponse({ success: true });
    return;
  }

  if (type === "VIDEO_SKIPPED") {
    console.log("[INDEX] VIDEO_SKIPPED received");
    showRecordingBar("Recording in progress (no video)");
    sendResponse({ success: true });
    return;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
console.log("[INDEX] Content script loaded, readyState:", document.readyState);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("[INDEX] DOMContentLoaded fired");
    createDevButton();
    checkAndResumeRecording();
  });
} else {
  console.log("[INDEX] Document already ready");
  createDevButton();
  checkAndResumeRecording();
}
