let isRecording = false;
let steps = [];
let variables = [];
let listenersAttached = false;
let lastClick = { selector: null, time: 0 };
let flushIntervalId = null;
let lastRightClickedElement = null;

const pendingInputs = new Map();

// Maps selectorKey → index in the GLOBAL steps array (never reset mid-recording)
// Survives flushes so we can overwrite the correct step across flush boundaries
const lastInputStepIndex = new Map();

// How many steps have already been flushed to background.
// steps[0] in the local array corresponds to global index flushedCount.
let flushedCount = 0;

const CLICK_DEBOUNCE_MS = 300;
const INPUT_DEBOUNCE_MS = 800;
const FLUSH_INTERVAL_MS = 2000;
const RECORDER_UI_ATTR = "data-automation-recorder-ui";

// ── Utils ─────────────────────────────────────────────────────────────────────
function isFromRecorderUi(target) {
  if (!target) return false;
  return (
    target.closest && target.closest(`[${RECORDER_UI_ATTR}="true"]`) !== null
  );
}

export function getLastRightClickedElement() {
  return lastRightClickedElement;
}

function nowTs() {
  return Date.now();
}

function getCssSelector(element) {
  if (!(element instanceof Element)) return null;

  const id = element.id;
  if (id && !/\d{3,}/.test(id)) {
    return `#${CSS.escape(id)}`;
  }

  if (element.classList.length) {
    const cls = Array.from(element.classList)
      .filter((c) => !/\d{3,}/.test(c))
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    if (cls) {
      return `${element.tagName.toLowerCase()}${cls}`;
    }
  }

  let path = "";
  let el = element;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.tagName.toLowerCase();
    if (el.id) {
      selector += `#${CSS.escape(el.id)}`;
      path = selector + (path ? " > " + path : "");
      break;
    } else {
      let sibling = el;
      let index = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === el.tagName) index++;
      }
      selector += `:nth-of-type(${index})`;
    }
    path = selector + (path ? " > " + path : "");
    el = el.parentElement;
  }

  return path || null;
}

function getXPath(element) {
  if (!(element instanceof Element)) return null;
  let segs = [];
  for (; element && element.nodeType === 1; element = element.parentNode) {
    if (element.hasAttribute("id")) {
      segs.unshift(
        `//*[@id="${element.getAttribute("id").replace(/"/g, '\\"')}"]`,
      );
      break;
    } else {
      let i = 1;
      let sib = element.previousSibling;
      for (; sib; sib = sib.previousSibling) {
        if (sib.nodeType === 1 && sib.nodeName === element.nodeName) i++;
      }
      segs.unshift(`${element.nodeName.toLowerCase()}[${i}]`);
    }
  }
  return segs.length ? "/" + segs.join("/") : null;
}

function buildSelectors(element) {
  const css = getCssSelector(element);
  const xpath = getXPath(element);
  return { css, xpath };
}

function getElementValue(el) {
  if (!el) return null;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return el.checked;
    return el.value;
  }
  if (el.tagName === "SELECT") return el.value;
  return el.textContent?.trim() ?? null;
}

// ── Label / Name Discovery ──────────────────────────────────────────────────
function findLabelText(element) {
  const id = element.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const text = label?.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  const wrappingLabel = element.closest("label");
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select")
      .forEach((i) => i.remove());
    const text = clone.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.length < 60) return ariaLabel;

  const ariaLabelledBy = element.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const labelEl = document.getElementById(ariaLabelledBy);
    const text = labelEl?.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  const placeholder = element.getAttribute("placeholder");
  if (placeholder && placeholder.length < 60) return placeholder;

  const prev = element.previousElementSibling;
  if (prev) {
    const text = prev.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  const parent = element.parentElement;
  if (parent) {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 1 && text.length < 60) return text;
      }
    }
  }

  const nameAttr = element.getAttribute("name");
  if (nameAttr && !/\d{3,}/.test(nameAttr)) return nameAttr;

  return null;
}

function generateVariableName(element, kind) {
  const label = findLabelText(element);
  const prefix = kind === "output" ? "out" : "in";

  if (label) {
    const cleaned = label
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .toLowerCase();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length) {
      const camel =
        tokens[0] +
        tokens
          .slice(1)
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
          .join("");
      return `${prefix}_${camel}`.slice(0, 50);
    }
  }

  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type") || "";
  const fallback = type ? `${tag}_${type}` : tag;
  return `${prefix}_${fallback}`.slice(0, 50);
}

// ── Step & Variable Creation ─────────────────────────────────────────────────
function createStep(type, element, value = null) {
  if (!element) return null;
  const { css, xpath } = buildSelectors(element);
  if (!css && !xpath) return null;

  return {
    type,
    selector: { css, xpath },
    value,
    targetTag: element.tagName.toLowerCase(),
    timestamp: nowTs(),
  };
}

/**
 * Record an input step for a field, overwriting any previous step for the
 * same field — even if that step was already flushed to the background.
 *
 * Strategy:
 *  - lastInputStepIndex stores the GLOBAL index (flushedCount + local index).
 *  - If the global index is still in the local `steps` array we overwrite it.
 *  - If it was already flushed we send a targeted PATCH message to background
 *    so it can overwrite that step in its own array.
 */
function recordInputStep(element, value) {
  const step = createStep("input", element, value);
  if (!step) return;

  const key = step.selector.css || step.selector.xpath;
  if (!key) {
    steps.push(step);
    return;
  }

  const globalIndex = lastInputStepIndex.get(key);

  if (globalIndex == null) {
    // First time we see this field — just push
    const newGlobalIndex = flushedCount + steps.length;
    steps.push(step);
    lastInputStepIndex.set(key, newGlobalIndex);
    return;
  }

  const localIndex = globalIndex - flushedCount;

  if (localIndex >= 0 && localIndex < steps.length) {
    // Step is still in the local buffer → overwrite directly
    steps[localIndex] = step;
  } else {
    // Step was already flushed → tell background to patch it
    chrome.runtime.sendMessage(
      {
        type: "RECORDER_PATCH_STEP",
        globalIndex,
        step,
      },
      () => {
        /* ignore errors */
      },
    );
    // Also update globalIndex in case value changes again after another flush
    lastInputStepIndex.set(key, globalIndex);
  }
}

function createVariable(kind) {
  const el =
    lastRightClickedElement ||
    (document.activeElement instanceof Element ? document.activeElement : null);

  if (!el) return null;

  const { css, xpath } = buildSelectors(el);
  if (!css && !xpath) return null;

  const value = getElementValue(el);
  const name = generateVariableName(el, kind);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name,
    selector: { css, xpath },
    value,
    targetTag: el.tagName.toLowerCase(),
    createdAt: new Date().toISOString(),
  };
}

// ── Flush ────────────────────────────────────────────────────────────────────
function flush() {
  if (!isRecording) return;
  if (!steps.length && !variables.length) return;

  const payload = { type: "RECORDER_FLUSH" };

  if (steps.length) {
    payload.steps = [...steps];
    // Advance the flushed counter but DO NOT clear lastInputStepIndex
    // so overwrite logic keeps working across flush boundaries
    flushedCount += steps.length;
    steps = [];
  }

  if (variables.length) {
    payload.variables = [...variables];
    variables = [];
  }

  chrome.runtime.sendMessage(payload, () => {
    /* ignore errors */
  });
}

// ── Event Handlers ───────────────────────────────────────────────────────────
function handleClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!isRecording) return;
  if (isFromRecorderUi(target)) return;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const now = nowTs();
  const { css } = buildSelectors(target);
  if (lastClick.selector === css && now - lastClick.time < CLICK_DEBOUNCE_MS) {
    return;
  }

  const step = createStep("click", target, null);
  if (step) {
    steps.push(step);
    lastClick = { selector: css, time: now };
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!isRecording) return;
  if (isFromRecorderUi(target)) return;

  const tag = target.tagName;
  if (
    tag !== "INPUT" &&
    tag !== "TEXTAREA" &&
    tag !== "SELECT" &&
    target.getAttribute("contenteditable") !== "true"
  ) {
    return;
  }

  const { css } = buildSelectors(target);
  const key = css || target;

  const existing = pendingInputs.get(key);
  if (existing) clearTimeout(existing.timeoutId);

  // SELECT: record immediately
  if (tag === "SELECT") {
    const value = getElementValue(target);
    recordInputStep(target, value);
    pendingInputs.delete(key);
    return;
  }

  // INPUT / TEXTAREA / contenteditable: debounce
  const timeoutId = setTimeout(() => {
    const value = getElementValue(target);
    recordInputStep(target, value);
    pendingInputs.delete(key);
  }, INPUT_DEBOUNCE_MS);

  pendingInputs.set(key, { timeoutId });
}

function handleBlur(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!isRecording) return;
  if (isFromRecorderUi(target)) return;

  const tag = target.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;

  const { css } = buildSelectors(target);
  const key = css || target;

  const existing = pendingInputs.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    pendingInputs.delete(key);
    // Force final step immediately on blur
    const value = getElementValue(target);
    recordInputStep(target, value);
  }
}

function handleContextMenu(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    lastRightClickedElement = null;
    return;
  }
  if (isFromRecorderUi(target)) return;
  lastRightClickedElement = target;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function startRecording() {
  if (isRecording) return;
  isRecording = true;
  steps = [];
  variables = [];
  lastClick = { selector: null, time: 0 };
  pendingInputs.clear();
  lastInputStepIndex.clear();
  flushedCount = 0; // reset global counter for fresh session

  if (!listenersAttached) {
    document.addEventListener("click", handleClick, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("blur", handleBlur, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    listenersAttached = true;
  }

  if (!flushIntervalId) {
    flushIntervalId = window.setInterval(flush, FLUSH_INTERVAL_MS);
  }
}

export function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  // Flush all pending debounced inputs immediately
  for (const [key, { timeoutId }] of pendingInputs) {
    clearTimeout(timeoutId);
    // key is either a css string or the element reference itself
    if (typeof key === "string") {
      // find matching element — best effort
      try {
        const el = document.querySelector(key);
        if (el) recordInputStep(el, getElementValue(el));
      } catch {
        /* invalid selector, skip */
      }
    }
  }
  pendingInputs.clear();

  flush(); // send whatever remains

  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Reset everything AFTER final flush
  lastInputStepIndex.clear();
  flushedCount = 0;
}

export function getStepsAndVariables() {
  // Flush all pending debounced inputs first
  for (const [key, { timeoutId }] of pendingInputs) {
    clearTimeout(timeoutId);
    if (typeof key === "string") {
      try {
        const el = document.querySelector(key);
        if (el) recordInputStep(el, getElementValue(el));
      } catch {
        /* skip */
      }
    }
  }
  pendingInputs.clear();

  const result = { steps: [...steps], variables: [...variables] };

  // Clear local buffers but keep lastInputStepIndex intact
  // in case stopRecording() is called right after
  steps = [];
  flushedCount += result.steps.length;
  variables = [];

  return result;
}

export function handleCreateVariable(kind) {
  if (!isRecording) return;
  const k = kind === "output" ? "output" : "input";
  const variable = createVariable(k);
  if (variable) {
    variables.push(variable);
    flush();
  }
}
