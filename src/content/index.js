import {
  startRecording,
  stopRecording,
  getStepsAndVariables,
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
  chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" }, (res) => {
    if (chrome.runtime.lastError) return;
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

// ── Dev Button ──
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

  btn.addEventListener("click", () => {
    if (!devRecording) {
      devRecording = true;
      startRecording();
      chrome.runtime.sendMessage({ type: "DEV_START_RECORDING" });
      showVideoPromptBar();
    } else {
      const { steps, variables } = getStepsAndVariables();
      devRecording = false;
      stopRecording();
      removeBar();
      chrome.runtime.sendMessage({
        type: "RECORDER_FLUSH",
        steps,
        variables,
      });
      chrome.runtime.sendMessage({ type: "DEV_STOP_RECORDING" });
    }
    updateDevButtonState();
  });

  document.documentElement.appendChild(btn);
  updateDevButtonState();
}

// ── Message Listener (background → content) ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;

  if (type === "START_RECORDING") {
    startRecording();
    showVideoPromptBar();
    sendResponse({ success: true });
    return;
  }

  if (type === "STOP_RECORDING") {
    const { steps, variables } = getStepsAndVariables();
    stopRecording();
    removeBar();
    chrome.runtime.sendMessage({
      type: "RECORDER_FLUSH",
      steps,
      variables,
    });
    sendResponse({ success: true, steps, variables });
    return;
  }

  if (type === "CREATE_VARIABLE") {
    handleCreateVariable(msg.kind);
    sendResponse({ success: true });
    return;
  }

  // Background tells content: video has started
  if (type === "VIDEO_STARTED") {
    showRecordingBar("Recording in progress (with video)");
    sendResponse({ success: true });
    return;
  }

  // Background tells content: video was skipped or failed
  if (type === "VIDEO_SKIPPED") {
    showRecordingBar("Recording in progress (no video)");
    sendResponse({ success: true });
    return;
  }
});

// ── Init ──
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    createDevButton();
    checkAndResumeRecording();
  });
} else {
  createDevButton();
  checkAndResumeRecording();
}
