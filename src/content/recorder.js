let isRecording = false;
let steps = [];
let variables = [];
let listenersAttached = false;
let lastClick = { selector: null, time: 0 };
let flushIntervalId = null;
let lastRightClickedElement = null;

// Track pending input steps so we only record the FINAL value
// selector → { timeoutId }
const pendingInputs = new Map();

// Track last recorded input step index per field so we overwrite instead of adding
// selectorKey (css/xpath) → index in `steps`
const lastInputStepIndex = new Map();

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
        if (sibling.tagName === el.tagName) {
          index++;
        }
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
    if (type === "checkbox" || type === "radio") {
      return el.checked;
    }
    return el.value;
  }
  if (el.tagName === "SELECT") {
    return el.value;
  }
  return el.textContent?.trim() ?? null;
}

// ── Label / Name Discovery ──
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
    const inputs = clone.querySelectorAll("input, textarea, select");
    inputs.forEach((i) => i.remove());
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

  let prev = element.previousElementSibling;
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

// ── Step & Variable Creation ──
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

// For input steps: keep only the *latest* step per selector
function recordInputStep(element, value) {
  const step = createStep("input", element, value);
  if (!step) return;

  const key =
    (step.selector && (step.selector.css || step.selector.xpath)) || null;

  if (!key) {
    steps.push(step);
    return;
  }

  const existingIndex = lastInputStepIndex.get(key);
  if (existingIndex != null) {
    steps[existingIndex] = step;
  } else {
    const index = steps.length;
    steps.push(step);
    lastInputStepIndex.set(key, index);
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

// ── Flush ──
function flush() {
  if (!isRecording) return;
  if (!steps.length && !variables.length) return;

  const payload = { type: "RECORDER_FLUSH" };
  if (steps.length) {
    payload.steps = [...steps];
    steps = [];
    lastInputStepIndex.clear();
  }
  if (variables.length) {
    payload.variables = [...variables];
    variables = [];
  }

  chrome.runtime.sendMessage(payload, () => {
    // ignore errors
  });
}

// ── Event Handlers ──
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
  if (existing) {
    clearTimeout(existing.timeoutId);
  }

  // SELECT: record immediately, keep only last via recordInputStep
  if (tag === "SELECT") {
    const value = getElementValue(target);
    recordInputStep(target, value);
    pendingInputs.delete(key);
    return;
  }

  // INPUT/TEXTAREA/contenteditable: debounce, then recordInputStep
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

    const value = getElementValue(target);
    // On blur, force a final step for that field, overwriting previous one
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

// ── Public API ──
export function startRecording() {
  if (isRecording) return;
  isRecording = true;
  steps = [];
  variables = [];
  lastClick = { selector: null, time: 0 };
  pendingInputs.clear();
  lastInputStepIndex.clear();

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

  for (const [, { timeoutId }] of pendingInputs) {
    clearTimeout(timeoutId);
  }
  pendingInputs.clear();
  lastInputStepIndex.clear();

  flush();

  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
}

export function getStepsAndVariables() {
  // Flush pending inputs before returning
  for (const [, { timeoutId }] of pendingInputs) {
    clearTimeout(timeoutId);
  }
  pendingInputs.clear();

  const result = { steps: [...steps], variables: [...variables] };
  steps = [];
  variables = [];
  lastInputStepIndex.clear();
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
