export const Actions = {
  START_RECORDING: "START_RECORDING",
  STOP_RECORDING: "STOP_RECORDING",
  GET_RECORDING_STATE: "GET_RECORDING_STATE",
  SET_TOKEN: "SET_TOKEN",
};

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://yourdomain.com",
]);

export function isValidExternalSender(sender) {
  const origin = sender?.origin;
  return ALLOWED_ORIGINS.has(origin);
}

export function isValidAction(action) {
  return Object.values(Actions).includes(action);
}

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0] || null;
}

export function sendCommandToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}
