let isRecording = false;
let steps = [];
let variables = [];
let listenersAttached = false;
let lastClick = { selector: null, time: 0 };
let lastRightClickedElement = null;
let flushIntervalId = null;

const pendingInputs = new Map();

const CLICK_DEBOUNCE_MS = 300;
const INPUT_DEBOUNCE_MS = 800;
const FLUSH_INTERVAL_MS = 2000;
const RECORDER_UI_ATTR = "data-automation-recorder-ui";

const CLICKABLE_INPUT_TYPES = new Set([
  "submit",
  "button",
  "reset",
  "checkbox",
  "radio",
]);

// ── Utils ─────────────────────────────────────────────────────────────────────

// ── Navigation flush: save steps before page unloads ──
function handleBeforeUnload() {
  if (!isRecording) return;
  console.log("[RECORDER][beforeunload] Page unloading — emergency flush");
  drainPendingInputs();
  const compressed = compressSteps([...steps]);
  const vars = [...variables];
  if (!compressed.length && !vars.length) return;
  try {
    chrome.runtime.sendMessage({
      type: "RECORDER_FLUSH",
      steps: compressed,
      variables: vars,
      isFinal: false,
    });
  } catch {
    /* page is dying, nothing we can do */
  }
}

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

function detectDataType(element) {
  if (!(element instanceof Element)) return "string";

  const tag = element.tagName;
  if (tag === "SELECT") return "enum";

  if (tag === "INPUT") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    switch (type) {
      case "number":
      case "range":
        return "number";
      case "email":
        return "email";
      case "url":
        return "url";
      case "tel":
        return "phone";
      case "date":
        return "date";
      case "datetime-local":
        return "datetime";
      case "time":
        return "time";
      case "month":
      case "week":
        return "date";
      case "checkbox":
        return "boolean";
      case "radio":
        return "enum";
      case "password":
        return "password";
      case "color":
        return "color";
      case "file":
        return "file";
      case "hidden":
        return "string";
      default:
        break;
    }

    const inputmode = element.getAttribute("inputmode");
    const name = (element.getAttribute("name") || "").toLowerCase();
    const id = (element.id || "").toLowerCase();
    const placeholder = (
      element.getAttribute("placeholder") || ""
    ).toLowerCase();

    if (inputmode === "numeric" || inputmode === "decimal") return "number";
    if (inputmode === "email") return "email";
    if (inputmode === "tel") return "phone";
    if (inputmode === "url") return "url";

    if (/email/i.test(name + id + placeholder)) return "email";
    if (/phone|tel|mobile/i.test(name + id + placeholder)) return "phone";
    if (/date|dob|birth/i.test(name + id + placeholder)) return "date";
    if (/url|website|link/i.test(name + id + placeholder)) return "url";
    if (/price|amount|cost|qty|quantity|total/i.test(name + id + placeholder))
      return "number";
    if (/zip|pin|postal/i.test(name + id + placeholder)) return "number";
    if (/password|passwd|pwd/i.test(name + id + placeholder)) return "password";

    const pattern = element.getAttribute("pattern");
    if (pattern) {
      if (/\\d/.test(pattern) && !/[a-zA-Z]/.test(pattern)) return "number";
    }

    return "string";
  }

  if (tag === "TEXTAREA") return "text";

  const textContent = (element.textContent || "").trim();
  if (textContent) {
    if (/^\d+(\.\d+)?$/.test(textContent)) return "number";
    if (/^\d{4}-\d{2}-\d{2}/.test(textContent)) return "date";
    if (/^https?:\/\//.test(textContent)) return "url";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(textContent)) return "email";
    if (/^(true|false)$/i.test(textContent)) return "boolean";
  }

  return "string";
}

// ── Page name extraction ──────────────────────────────────────────────────────
function getPageName() {
  // Strategy 1: Breadcrumb — last item is usually the current page
  const breadcrumb = document.querySelector(
    '[aria-label="breadcrumb"], .breadcrumb, .breadcrumbs, nav.breadcrumb, ol.breadcrumb, [role="navigation"][aria-label*="breadcrumb" i]',
  );
  if (breadcrumb) {
    const items = breadcrumb.querySelectorAll(
      "li, a, span, .breadcrumb-item, [aria-current]",
    );
    if (items.length) {
      // Prefer the item with aria-current="page"
      for (const item of items) {
        if (item.getAttribute("aria-current") === "page") {
          const text = item.textContent?.trim();
          if (text && text.length > 0 && text.length < 60) return text;
        }
      }
      // Otherwise use the last breadcrumb item
      const last = items[items.length - 1];
      const text = last.textContent?.trim();
      if (text && text.length > 0 && text.length < 60) return text;
    }
  }

  // Strategy 2: Active nav/tab/sidebar item — indicates current section
  const activeNavItem = document.querySelector(
    'nav a.active, nav a[aria-current="page"], nav .active > a, ' +
      '.sidebar a.active, .sidebar .active > a, .sidebar a[aria-current="page"], ' +
      ".nav-link.active, .nav-item.active > a, " +
      '[role="tab"][aria-selected="true"], ' +
      ".MuiTab-root.Mui-selected, .ant-menu-item-selected, " +
      ".menu-item.active, .menu-item.selected, " +
      "a.router-link-active, a.router-link-exact-active",
  );
  if (activeNavItem) {
    const text = activeNavItem.textContent?.trim();
    if (text && text.length > 0 && text.length < 60) return text;
  }

  // Strategy 3: Page-level heading (h1 directly under main/body, not inside cards/modals)
  const mainContent = document.querySelector(
    'main, [role="main"], #content, #main, .main-content, .page-content, .content-area',
  );
  if (mainContent) {
    // Direct h1/h2 child or shallow descendant of main
    const heading = mainContent.querySelector(
      ":scope > h1, :scope > h2, :scope > header h1, :scope > header h2, " +
        ":scope > div > h1, :scope > div > h2, :scope > .page-header h1, :scope > .page-title",
    );
    if (heading) {
      const text = heading.textContent?.trim();
      if (text && text.length > 0 && text.length < 60) return text;
    }
  }

  // Strategy 4: First visible h1 that is NOT inside a modal, card, sidebar, or accordion
  const allH1s = document.querySelectorAll("h1");
  for (const h1 of allH1s) {
    // Skip headings inside overlay/widget containers
    if (
      h1.closest(
        '[role="dialog"], [aria-modal="true"], .modal, .card, .sidebar, ' +
          '.drawer, aside, .accordion, .collapse, [role="complementary"]',
      )
    ) {
      continue;
    }
    // Skip hidden headings
    const rect = h1.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const text = h1.textContent?.trim();
    if (text && text.length > 0 && text.length < 60) return text;
  }

  // Strategy 5: First visible h2 (same exclusions)
  const allH2s = document.querySelectorAll("h2");
  for (const h2 of allH2s) {
    if (
      h2.closest(
        '[role="dialog"], [aria-modal="true"], .modal, .card, .sidebar, ' +
          '.drawer, aside, .accordion, .collapse, [role="complementary"]',
      )
    ) {
      continue;
    }
    const rect = h2.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const text = h2.textContent?.trim();
    if (text && text.length > 0 && text.length < 60) return text;
  }

  // Strategy 6: aria-label on main/content region
  if (mainContent) {
    const ariaLabel = mainContent.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.length < 60) return ariaLabel;
  }

  // Strategy 7: Page title meta tag or <title> (cleaned up)
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute("content")?.trim();
    if (content && content.length > 0 && content.length < 60) return content;
  }

  // Strategy 8: Extract from URL path for SPAs
  const path = window.location.pathname;
  if (path && path !== "/") {
    const segments = path
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^[0-9a-f\-]{8,}$/i.test(s)) // skip UUIDs
      .filter((s) => !/^\d+$/.test(s)); // skip numeric IDs
    if (segments.length) {
      return segments
        .map((s) =>
          s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        )
        .join(" › ");
    }
  }

  // Strategy 9: Hash routing for SPAs
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash) {
    const segments = hash
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^[0-9a-f\-]{8,}$/i.test(s))
      .filter((s) => !/^\d+$/.test(s));
    if (segments.length) {
      return segments
        .map((s) =>
          s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        )
        .join(" › ");
    }
  }

  // Strategy 10: Fall back to document.title (cleaned)
  const title = (document.title || "").trim();
  if (title) {
    const cleaned = title.split(/\s*[\-\|·»::]\s*/)[0].trim();
    if (cleaned && cleaned.length > 0 && cleaned.length < 60) return cleaned;
    return title.length > 60 ? title.slice(0, 60) : title;
  }

  return "Unknown Page";
}

// ── Variable context detection (expanded) ─────────────────────────────────────
function detectVariableContext(element) {
  if (!(element instanceof Element)) return { type: "formField" };

  // ── Table context ──
  const tableCell = element.closest("td, th");
  const tableRow = element.closest("tr");
  const table = element.closest("table");
  const datagrid = element.closest(
    '[role="grid"], [role="table"], [role="treegrid"]',
  );

  if (tableCell || datagrid) {
    const context = {
      type: "table",
      rowIndex: null,
      columnIndex: null,
      columnHeader: null,
    };

    if (tableRow && tableCell) {
      const cells = Array.from(tableRow.children);
      context.columnIndex = cells.indexOf(tableCell);

      if (table) {
        const thead = table.querySelector("thead");
        if (thead) {
          const headerCells = thead.querySelectorAll("th, td");
          if (context.columnIndex < headerCells.length) {
            context.columnHeader =
              headerCells[context.columnIndex]?.textContent?.trim() || null;
          }
        }
      }

      const tbody = tableRow.closest("tbody") || table;
      if (tbody) {
        const rows = Array.from(tbody.querySelectorAll("tr"));
        context.rowIndex = rows.indexOf(tableRow);
      }
    }

    return context;
  }

  // ── Modal / Dialog context ──
  const modal = element.closest(
    '[role="dialog"], [role="alertdialog"], .modal, .dialog, [aria-modal="true"], .MuiDialog-root, .ant-modal, .chakra-modal__content',
  );
  if (modal) {
    const modalTitle =
      modal
        .querySelector(
          '[role="heading"], .modal-title, .dialog-title, h1, h2, h3',
        )
        ?.textContent?.trim() || null;
    return {
      type: "modal",
      modalTitle,
      modalId: modal.id || null,
      modalRole: modal.getAttribute("role") || "dialog",
    };
  }

  // ── Sidebar / Drawer context ──
  const sidebar = element.closest(
    'aside, nav[role="navigation"], .sidebar, .drawer, .side-panel, [role="complementary"], .MuiDrawer-root, .ant-drawer',
  );
  if (sidebar) {
    const sidebarTitle =
      sidebar
        .querySelector("h1, h2, h3, .sidebar-title, .drawer-title")
        ?.textContent?.trim() || null;
    return {
      type: "sidebar",
      sidebarTitle,
      sidebarId: sidebar.id || null,
    };
  }

  // ── Navbar / Header context ──
  const navbar = element.closest(
    'header, nav, [role="banner"], [role="navigation"], .navbar, .nav-bar, .header, .top-bar, .MuiAppBar-root',
  );
  if (navbar) {
    return {
      type: "navbar",
      navbarId: navbar.id || null,
    };
  }

  // ── Accordion / Collapsible context ──
  const accordion = element.closest(
    '.accordion, .collapse, .collapsible, [role="tabpanel"], .MuiAccordion-root, .ant-collapse-item, details',
  );
  if (accordion) {
    const accordionTitle =
      accordion
        .querySelector(
          '.accordion-header, .accordion-title, summary, [role="tab"], .MuiAccordionSummary-content, .ant-collapse-header',
        )
        ?.textContent?.trim() || null;
    return {
      type: "accordion",
      sectionTitle: accordionTitle,
      expanded:
        accordion.classList.contains("show") ||
        accordion.classList.contains("expanded") ||
        accordion.hasAttribute("open") ||
        accordion.getAttribute("aria-expanded") === "true",
    };
  }

  // ── Card / Panel context ──
  const card = element.closest(
    '.card, .panel, .tile, .MuiCard-root, .ant-card, [role="group"], .chakra-card',
  );
  if (card) {
    const cardTitle =
      card
        .querySelector(
          ".card-title, .card-header, .panel-heading, .panel-title, .MuiCardHeader-title, .ant-card-head-title, h1, h2, h3, h4",
        )
        ?.textContent?.trim() || null;
    return {
      type: "card",
      cardTitle,
      cardId: card.id || null,
    };
  }

  // ── Toolbar context ──
  const toolbar = element.closest(
    '[role="toolbar"], .toolbar, .MuiToolbar-root, .action-bar, .button-bar',
  );
  if (toolbar) {
    return {
      type: "toolbar",
      toolbarId: toolbar.id || null,
    };
  }

  // ── Footer context ──
  const footer = element.closest('footer, [role="contentinfo"], .footer');
  if (footer) {
    return {
      type: "footer",
      footerId: footer.id || null,
    };
  }

  // ── Tab panel context ──
  const tabPanel = element.closest(
    '[role="tabpanel"], .tab-pane, .tab-content, .MuiTabPanel-root',
  );
  if (tabPanel) {
    const tabLabel =
      tabPanel.getAttribute("aria-label") ||
      tabPanel.getAttribute("aria-labelledby") ||
      null;
    let tabTitle = null;
    if (tabLabel && !tabTitle) {
      const labelEl = document.getElementById(tabLabel);
      tabTitle = labelEl?.textContent?.trim() || tabLabel;
    }
    return {
      type: "tabPanel",
      tabTitle,
      tabPanelId: tabPanel.id || null,
    };
  }

  // ── Dropdown / Popover context ──
  const dropdown = element.closest(
    '.dropdown, .dropdown-menu, .popover, [role="listbox"], [role="menu"], .MuiMenu-list, .MuiPopover-root, .ant-dropdown',
  );
  if (dropdown) {
    return {
      type: "dropdown",
      dropdownId: dropdown.id || null,
    };
  }

  // ── Form context (default for form fields) ──
  const form = element.closest("form");
  if (form) {
    const formTitle =
      form
        .querySelector("h1, h2, h3, h4, legend, .form-title")
        ?.textContent?.trim() || null;
    return {
      type: "formField",
      formId: form.id || null,
      formName: form.getAttribute("name") || null,
      formAction: form.getAttribute("action") || null,
      formTitle,
    };
  }

  // ── Standalone form field (no <form> wrapper) ──
  return { type: "formField" };
}

// ── Relative XPath generation ─────────────────────────────────────────────────
function getRelativeXPath(element) {
  if (!(element instanceof Element)) return null;

  // Strategy 1: id-based (shortest)
  if (element.id && !/\d{5,}/.test(element.id)) {
    return `//*[@id="${element.id}"]`;
  }

  // Strategy 2: label-based for form fields
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    const type = (element.getAttribute("type") || "text").toLowerCase();

    // For radio buttons — use name + value
    if (type === "radio") {
      const name = element.getAttribute("name");
      const value = element.getAttribute("value");
      if (name && value) {
        return `//input[@name="${name}" and @value="${value}"]`;
      }
      if (name) {
        // Find visible label text for this specific radio
        const label = findLabelText(element);
        if (label) {
          const safeLabel = label.replace(/'/g, "\\'");
          return `//label[contains(normalize-space(.),'${safeLabel}')]/input[@type='radio']`;
        }
        return `//input[@name="${name}" and @type="radio"]`;
      }
    }

    // For checkboxes — use name + value or label
    if (type === "checkbox") {
      const name = element.getAttribute("name");
      const value = element.getAttribute("value");
      if (name && value) {
        return `//input[@name="${name}" and @value="${value}"]`;
      }
      const label = findLabelText(element);
      if (label) {
        const safeLabel = label.replace(/'/g, "\\'");
        return `//label[contains(normalize-space(.),'${safeLabel}')]/input[@type='checkbox']`;
      }
      if (name) {
        return `//input[@name="${name}" and @type="checkbox"]`;
      }
    }

    const labelText = findLabelText(element);
    if (labelText) {
      const safeLabel = labelText.replace(/'/g, "\\'");
      const tag = element.tagName.toLowerCase();

      if (element.id) {
        return `//${tag}[@id="${element.id}"]`;
      }

      const name = element.getAttribute("name");
      if (name) {
        return `//${tag}[@name="${name}"]`;
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        return `//${tag}[@placeholder="${placeholder}"]`;
      }

      return `//label[contains(normalize-space(.),'${safeLabel}')]/following::${tag}[1]`;
    }

    const name = element.getAttribute("name");
    if (name && !/\d{5,}/.test(name)) {
      return `//${element.tagName.toLowerCase()}[@name="${name}"]`;
    }

    const placeholder = element.getAttribute("placeholder");
    if (placeholder) {
      return `//${element.tagName.toLowerCase()}[@placeholder="${placeholder}"]`;
    }
  }

  // Strategy 3: text-based for buttons/links
  if (element.tagName === "BUTTON" || element.tagName === "A") {
    const text = getDirectTextContent(element)?.trim();
    if (text && text.length < 50) {
      const safeText = text.replace(/'/g, "\\'");
      const tag = element.tagName.toLowerCase();
      return `//${tag}[normalize-space(.)='${safeText}']`;
    }
  }

  // Strategy 4: role + text
  const role = element.getAttribute("role");
  if (role) {
    const text = (element.textContent || "").trim().slice(0, 50);
    if (text) {
      const safeText = text.replace(/'/g, "\\'");
      return `//*[@role="${role}" and contains(normalize-space(.),'${safeText}')]`;
    }
    return `//*[@role="${role}"]`;
  }

  // Strategy 5: aria-label
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return `//*[@aria-label="${ariaLabel}"]`;
  }

  // Strategy 6: class-based relative
  if (element.classList.length) {
    const mainClass = Array.from(element.classList).find(
      (c) => !/\d{3,}/.test(c) && c.length > 2,
    );
    if (mainClass) {
      const tag = element.tagName.toLowerCase();
      return `//${tag}[contains(@class,'${mainClass}')]`;
    }
  }

  // Strategy 7: For table cells, use row/col position
  const td = element.closest("td, th");
  if (td) {
    const tr = td.closest("tr");
    const table = td.closest("table");
    if (tr && table) {
      const rows = Array.from(
        (table.querySelector("tbody") || table).querySelectorAll("tr"),
      );
      const rowIdx = rows.indexOf(tr) + 1;
      const cells = Array.from(tr.children);
      const colIdx = cells.indexOf(td) + 1;
      const tableXPath = table.id ? `//table[@id="${table.id}"]` : "//table";
      return `${tableXPath}//tr[${rowIdx}]/td[${colIdx}]`;
    }
  }

  // Fallback: absolute XPath
  return getXPath(element);
}

function buildSelectors(element) {
  const css = getCssSelector(element);
  const xpath = getXPath(element);
  const relativeXPath = getRelativeXPath(element);
  return { css, xpath, relativeXPath };
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

// ── Radio / Checkbox value helpers ────────────────────────────────────────────
function getRadioSelectedLabel(element) {
  // For a radio button, find the label text for the specific option
  const label = findLabelText(element);
  if (label) return label;

  // Check for adjacent text node (common pattern: <input type="radio"> Male)
  const nextSibling = element.nextSibling;
  if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
    const text = nextSibling.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  // Check next element sibling
  const nextEl = element.nextElementSibling;
  if (nextEl && (nextEl.tagName === "SPAN" || nextEl.tagName === "LABEL")) {
    const text = nextEl.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  // Fallback to value attribute
  return element.getAttribute("value") || "selected";
}

function getCheckboxLabel(element) {
  const label = findLabelText(element);
  if (label) return label;

  const nextSibling = element.nextSibling;
  if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
    const text = nextSibling.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  const nextEl = element.nextElementSibling;
  if (nextEl && (nextEl.tagName === "SPAN" || nextEl.tagName === "LABEL")) {
    const text = nextEl.textContent?.trim();
    if (text && text.length < 60) return text;
  }

  return (
    element.getAttribute("value") || element.getAttribute("name") || "checkbox"
  );
}

// ── Clickable ancestor resolution ─────────────────────────────────────────────
const MAX_ANCESTOR_WALK = 5;

function isInputElement(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !CLICKABLE_INPUT_TYPES.has(type);
  }
  if (el.getAttribute("contenteditable") === "true") return true;
  return false;
}

function resolveClickTarget(rawEl) {
  // For radio buttons and checkboxes, return the input itself directly
  if (rawEl.tagName === "INPUT") {
    const type = (rawEl.getAttribute("type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      return rawEl;
    }
  }

  if (isInputElement(rawEl)) {
    return null;
  }

  let el = rawEl;
  let walked = 0;
  while (el && el !== document.body && walked < MAX_ANCESTOR_WALK) {
    if (!(el instanceof Element)) {
      el = el.parentElement;
      walked++;
      continue;
    }
    const tag = el.tagName;

    if (tag === "BUTTON") return el;

    if (tag === "A" && (el.hasAttribute("href") || el.getAttribute("role"))) {
      return el;
    }

    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (CLICKABLE_INPUT_TYPES.has(type)) return el;
      return null;
    }

    if (tag === "TEXTAREA" || tag === "SELECT") return null;

    if (tag === "LABEL") {
      // If label wraps or is for a radio/checkbox, resolve to that input
      const forAttr = el.getAttribute("for");
      if (forAttr) {
        const targetInput = document.getElementById(forAttr);
        if (targetInput && targetInput.tagName === "INPUT") {
          const inputType = (
            targetInput.getAttribute("type") || "text"
          ).toLowerCase();
          if (inputType === "radio" || inputType === "checkbox") {
            return targetInput;
          }
        }
        if (targetInput) return null;
      }
      const wrappedInput = el.querySelector("input, textarea, select");
      if (wrappedInput) {
        const wrappedType = (
          wrappedInput.getAttribute("type") || "text"
        ).toLowerCase();
        if (wrappedType === "radio" || wrappedType === "checkbox") {
          return wrappedInput;
        }
        return null;
      }
      return el;
    }

    const role = el.getAttribute("role");
    if (
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "option" ||
      role === "checkbox" ||
      role === "radio"
    ) {
      return el;
    }

    if (el.hasAttribute("onclick")) return el;

    el = el.parentElement;
    walked++;
  }

  try {
    const style = window.getComputedStyle(rawEl);
    if (style.cursor === "pointer" || rawEl.hasAttribute("tabindex")) {
      return rawEl;
    }
  } catch {
    /* skip */
  }

  return null;
}

// ── Label / Name Discovery ────────────────────────────────────────────────────
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

// ── Step & Variable Creation ──────────────────────────────────────────────────
function createStep(type, element, value = null) {
  if (!element) {
    return null;
  }
  const { css, xpath, relativeXPath } = buildSelectors(element);
  if (!css && !xpath) {
    return null;
  }

  const pageName = getPageName();
  const context = detectVariableContext(element);

  const step = {
    type,
    selector: { css, xpath, relativeXPath },
    value,
    targetTag: element.tagName.toLowerCase(),
    timestamp: nowTs(),
    pageUrl: window.location.href,
    pageTitle: document.title || null,
    pageName,
    context: typeof context === "object" ? context : { type: context },
  };
  return step;
}

function getDirectTextContent(el) {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
  }
  const trimmed = text.trim().slice(0, 80);
  if (!trimmed && el.children.length === 0)
    return el.textContent?.trim().slice(0, 80) || null;
  return trimmed || null;
}

function createVariable(kind) {
  const el =
    lastRightClickedElement ||
    (document.activeElement instanceof Element ? document.activeElement : null);
  if (!el) return null;

  const { css, xpath, relativeXPath } = buildSelectors(el);
  if (!css && !xpath) return null;

  const value = getElementValue(el);
  const name = generateVariableName(el, kind);
  const dataType = detectDataType(el);
  const context = detectVariableContext(el);
  const pageName = getPageName();

  let enumValues = null;
  if (el.tagName === "SELECT") {
    enumValues = Array.from(el.options).map((opt) => ({
      value: opt.value,
      label: opt.textContent?.trim() || opt.value,
    }));
  }
  // For radio groups, collect all options
  if (
    el.tagName === "INPUT" &&
    (el.getAttribute("type") || "").toLowerCase() === "radio"
  ) {
    const radioName = el.getAttribute("name");
    if (radioName) {
      const radios = document.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(radioName)}"]`,
      );
      enumValues = Array.from(radios).map((r) => {
        const optLabel = getRadioSelectedLabel(r);
        return {
          value: r.getAttribute("value") || optLabel,
          label: optLabel,
        };
      });
    }
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name,
    selector: { css, xpath, relativeXPath },
    value,
    dataType,
    context,
    enumValues,
    targetTag: el.tagName.toLowerCase(),
    inputType: el.getAttribute("type") || null,
    pageUrl: window.location.href,
    pageTitle: document.title || null,
    pageName,
    createdAt: new Date().toISOString(),
  };
}

// ── Compress: keep only last input step per selector ─────────────────────────
function compressSteps(allSteps) {
  const lastInputIdx = new Map();
  allSteps.forEach((step, index) => {
    if (step.type !== "input") return;
    const key = step.selector?.css || step.selector?.xpath;
    if (key) lastInputIdx.set(key, index);
  });
  const result = allSteps.filter((step, index) => {
    if (step.type !== "input") return true;
    const key = step.selector?.css || step.selector?.xpath;
    if (!key) return true;
    return lastInputIdx.get(key) === index;
  });
  return result;
}

// ── Flush helpers ─────────────────────────────────────────────────────────────
function sendFlush(isFinal) {
  const compressed = compressSteps([...steps]);
  const vars = [...variables];

  if (!compressed.length && !vars.length) {
    return Promise.resolve();
  }

  const payload = {
    type: "RECORDER_FLUSH",
    steps: compressed,
    variables: vars,
    isFinal,
  };

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[RECORDER][sendFlush] chrome.runtime.lastError:",
            chrome.runtime.lastError.message,
          );
        }
        resolve(res);
      });
    } catch (err) {
      console.error("[RECORDER][sendFlush] sendMessage threw:", err.message);
      resolve(null);
    }
  });
}

function periodicFlush() {
  if (!isRecording) return;
  if (!steps.length && !variables.length) return;
  sendFlush(false);
}

// ── Drain pending debounce timers ─────────────────────────────────────────────
function drainPendingInputs() {
  for (const [key, { timeoutId, element }] of pendingInputs) {
    clearTimeout(timeoutId);
    if (element instanceof Element) {
      try {
        const value = getElementValue(element);
        const step = createStep("input", element, value);
        if (step) {
          steps.push(step);
        }
      } catch {
        /* skip */
      }
    }
  }
  pendingInputs.clear();
}

// ── Event Handlers ────────────────────────────────────────────────────────────

function handleClick(event) {
  const raw = event.target;
  if (!isRecording) return;

  const rawEl = raw instanceof Element ? raw : raw?.parentElement;
  if (!rawEl) return;
  if (isFromRecorderUi(rawEl)) return;

  const target = resolveClickTarget(rawEl);
  if (!target) return;

  const { css } = buildSelectors(target);
  const now = nowTs();
  if (lastClick.selector === css && now - lastClick.time < CLICK_DEBOUNCE_MS) {
    return;
  }

  // Determine if radio or checkbox
  const isRadio =
    target.tagName === "INPUT" &&
    (target.getAttribute("type") || "").toLowerCase() === "radio";
  const isCheckbox =
    target.tagName === "INPUT" &&
    (target.getAttribute("type") || "").toLowerCase() === "checkbox";

  let value = null;
  let stepType = "click";

  if (isRadio) {
    stepType = "select";
    value = getRadioSelectedLabel(target);
  } else if (isCheckbox) {
    stepType = "check";
    const label = getCheckboxLabel(target);
    value = `${label}: ${target.checked ? "checked" : "unchecked"}`;
  } else {
    value =
      target.getAttribute("aria-label") ||
      target.getAttribute("title") ||
      getDirectTextContent(target) ||
      null;
  }

  const step = createStep(stepType, target, value);
  if (step) {
    // Add extra metadata for radio/checkbox
    if (isRadio || isCheckbox) {
      step.inputType = (target.getAttribute("type") || "").toLowerCase();
      step.checked = target.checked;
      step.fieldName = target.getAttribute("name") || null;
    }

    steps.push(step);
    lastClick = { selector: css, time: now };

    // If this click might cause navigation, flush immediately
    const mightNavigate =
      target.tagName === "A" ||
      (target.tagName === "BUTTON" &&
        (target.getAttribute("type") === "submit" ||
          !target.getAttribute("type"))) ||
      (target.tagName === "INPUT" && target.getAttribute("type") === "submit");

    if (mightNavigate) {
      drainPendingInputs();
      sendFlush(false);
    }
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
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") || "text").toLowerCase();
    if (CLICKABLE_INPUT_TYPES.has(type)) return;
  }

  const { css } = buildSelectors(target);
  const key = css || target;

  const existing = pendingInputs.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
  }

  if (tag === "SELECT") {
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) steps.push(step);
    pendingInputs.delete(key);
    return;
  }

  const timeoutId = setTimeout(() => {
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) {
      steps.push(step);
    }
    pendingInputs.delete(key);
  }, INPUT_DEBOUNCE_MS);

  pendingInputs.set(key, { timeoutId, element: target });
}

function handleBlur(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!isRecording) return;
  if (isFromRecorderUi(target)) return;

  const tag = target.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") || "text").toLowerCase();
    if (CLICKABLE_INPUT_TYPES.has(type)) return;
  }

  const { css } = buildSelectors(target);
  const key = css || target;
  const existing = pendingInputs.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    pendingInputs.delete(key);
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) {
      steps.push(step);
    }
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

function handleSubmit(event) {
  const form = event.target;
  if (!isRecording) return;
  if (!(form instanceof HTMLFormElement)) return;
  if (isFromRecorderUi(form)) return;

  const submitBtn =
    form.querySelector('button[type="submit"]') ||
    form.querySelector('input[type="submit"]') ||
    form.querySelector("button:not([type])");

  const target = submitBtn || form;
  const { css } = buildSelectors(target);

  const lastStep = steps[steps.length - 1];
  if (lastStep && lastStep.type === "click" && lastStep.selector?.css === css) {
    drainPendingInputs();
    sendFlush(false);
    return;
  }

  const value =
    target.getAttribute("aria-label") ||
    target.getAttribute("title") ||
    getDirectTextContent(target) ||
    null;

  const step = createStep("submit", target, value);
  if (step) {
    steps.push(step);
    drainPendingInputs();
    sendFlush(false);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startRecording() {
  if (isRecording) return;
  isRecording = true;
  steps = [];
  variables = [];
  lastClick = { selector: null, time: 0 };
  pendingInputs.clear();

  if (!listenersAttached) {
    document.addEventListener("click", handleClick, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("blur", handleBlur, true);
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    window.addEventListener("beforeunload", handleBeforeUnload);
    listenersAttached = true;
  }

  if (!flushIntervalId) {
    flushIntervalId = window.setInterval(periodicFlush, FLUSH_INTERVAL_MS);
  }
}

export async function stopRecording() {
  if (!isRecording) {
    return { steps: [], variables: [] };
  }

  isRecording = false;

  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  drainPendingInputs();
  await sendFlush(true);

  const result = {
    steps: compressSteps([...steps]),
    variables: [...variables],
  };

  steps = [];
  variables = [];

  return result;
}

export function handleCreateVariable(kind) {
  if (!isRecording) return;
  const k = kind === "output" ? "output" : "input";
  const variable = createVariable(k);
  if (variable) {
    variables.push(variable);
    console.log("[RECORDER] variable added:", variable.name);
  }
}
