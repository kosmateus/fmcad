import {
  LOCALE_CODES,
  LOCALE_INFO,
  type LocaleCode,
} from "./locale-catalogs.js";
import type { LocaleRuntime, LocaleSnapshot } from "./locale-runtime.js";

const COLORS = {
  white: "#ffffff",
  black: "#111111",
  red: "#d62631",
  darkRed: "#8c1c31",
  blue: "#21468b",
  lightBlue: "#4b9bd5",
  green: "#238348",
  yellow: "#ffcc00",
  orange: "#ff883e",
} as const;

const rows = (...colors: readonly string[]): string =>
  colors
    .map(
      (color, index) =>
        `<rect x="0" y="${(16 / colors.length) * index}" width="24" height="${16 / colors.length + 0.1}" fill="${color}"/>`,
    )
    .join("");

const columns = (...colors: readonly string[]): string =>
  colors
    .map(
      (color, index) =>
        `<rect x="${(24 / colors.length) * index}" y="0" width="${24 / colors.length + 0.1}" height="16" fill="${color}"/>`,
    )
    .join("");

const crosses = (
  background: string,
  cross: string,
  verticalAt: number,
): string =>
  `<rect width="24" height="16" fill="${background}"/><rect x="${verticalAt}" width="2.7" height="16" fill="${cross}"/><rect y="6.7" width="24" height="2.7" fill="${cross}"/>`;

const FLAG_ART: Readonly<Record<LocaleCode, string>> = {
  bg: rows(COLORS.white, COLORS.green, COLORS.red),
  hr: `${rows(COLORS.red, COLORS.white, COLORS.blue)}<path d="M10 4h4v7l-2 2-2-2z" fill="#ffffff"/><path d="M10 4h1v2h2V4h1v3h-4zm0 4h4v3l-2 2-2-2z" fill="#d62631" stroke="#21468b" stroke-width=".35"/>`,
  cs: `${rows(COLORS.white, COLORS.red)}<path d="M0 0 13 8 0 16z" fill="${COLORS.blue}"/>`,
  da: crosses(COLORS.red, COLORS.white, 7),
  nl: rows(COLORS.red, COLORS.white, COLORS.blue),
  en: `<rect width="24" height="16" fill="#21468b"/><path d="M0 0 24 16M24 0 0 16" stroke="#ffffff" stroke-width="3.4"/><path d="M0 0 24 16M24 0 0 16" stroke="#c8102e" stroke-width="1.35"/><path d="M12 0v16M0 8h24" stroke="#ffffff" stroke-width="5"/><path d="M12 0v16M0 8h24" stroke="#c8102e" stroke-width="2.6"/>`,
  et: rows("#4891d9", COLORS.black, COLORS.white),
  fi: crosses(COLORS.white, "#003580", 7),
  fr: columns("#0055a4", COLORS.white, "#ef4135"),
  de: rows(COLORS.black, "#dd0000", "#ffce00"),
  el: `${rows("#0d5eaf", COLORS.white, "#0d5eaf", COLORS.white, "#0d5eaf", COLORS.white, "#0d5eaf", COLORS.white, "#0d5eaf")}<rect width="9" height="9" fill="#0d5eaf"/><rect x="3.7" width="1.8" height="9" fill="#ffffff"/><rect y="3.6" width="9" height="1.8" fill="#ffffff"/>`,
  hu: rows(COLORS.red, COLORS.white, COLORS.green),
  ga: columns("#169b62", COLORS.white, "#ff883e"),
  it: columns(COLORS.green, COLORS.white, COLORS.red),
  lv: rows(COLORS.darkRed, COLORS.white, COLORS.darkRed),
  lt: rows("#fdb913", COLORS.green, COLORS.red),
  mt: `${columns(COLORS.white, COLORS.red)}<path d="M3 2h3v1.2H4.2v1.6H3z" fill="#b7b7b7"/><path d="M4.2 1.2h1.2v3.6H4.2zM3 2.4h3.6v1.2H3z" fill="#b7b7b7"/>`,
  pl: rows(COLORS.white, COLORS.red),
  pt: `${columns("#006600", "#ff0000")}<circle cx="9.2" cy="8" r="2.7" fill="#ffcc00" stroke="#ffffff" stroke-width=".45"/>`,
  ro: columns("#002b7f", "#fcd116", "#ce1126"),
  sk: `${rows(COLORS.white, "#0b4ea2", COLORS.red)}<path d="M7 5 9.5 6 12 5l2.5 1V10c0 2-2.5 3.4-2.5 3.4S9.5 12 9.5 10V6z" fill="#ffffff" stroke="#d62631" stroke-width=".5"/><path d="M8.5 9.2h4v.7h-4zm1.6-1.6h.7v3.4h-.7z" fill="#d62631"/>`,
  sl: `${rows(COLORS.white, COLORS.blue, COLORS.red)}<path d="M7 5 9.5 6 12 5l2.5 1V10c0 2-2.5 3.4-2.5 3.4S9.5 12 9.5 10V6z" fill="#ffffff" stroke="#d62631" stroke-width=".5"/><path d="M8.5 9.2h4v.7h-4zm1.6-1.6h.7v3.4h-.7z" fill="#21468b"/>`,
  es: rows("#aa151b", "#f1bf00", "#aa151b"),
  sv: crosses("#006aa7", "#fecc00", 7),
  uk: rows("#0057b7", "#ffd700"),
};

const STYLE_ID = "fmcad-locale-selector-styles";
const STYLE_PATH = "/assets/control-center/assets/locale-selector.css";

function ensureStyles(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const stylesheet = document.createElement("link");
  stylesheet.id = STYLE_ID;
  stylesheet.rel = "stylesheet";
  stylesheet.href = STYLE_PATH;
  document.head.append(stylesheet);
}

function flagElement(document: Document, locale: LocaleCode): SVGSVGElement {
  const flag = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  flag.setAttribute("class", "locale-flag");
  flag.setAttribute("viewBox", "0 0 24 16");
  flag.setAttribute("aria-hidden", "true");
  flag.setAttribute("focusable", "false");
  flag.innerHTML = `${FLAG_ART[locale]}<rect x=".25" y=".25" width="23.5" height="15.5" rx="1.5" fill="none" stroke="#ffffff38" stroke-width=".5"/>`;
  return flag;
}

function systemIcon(document: Document): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "locale-system-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>';
  return icon;
}

function menuButton(
  document: Document,
  locale: LocaleCode | "system",
  text: string,
  selected: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "locale-option";
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", String(selected));
  button.dataset["locale"] = locale;
  button.append(
    locale === "system" ? systemIcon(document) : flagElement(document, locale),
  );
  const label = document.createElement("span");
  label.className = "locale-option-name";
  label.textContent = text;
  const check = document.createElement("span");
  check.className = "locale-option-check";
  check.setAttribute("aria-hidden", "true");
  check.textContent = selected ? "✓" : "";
  button.append(label, check);
  return button;
}

export interface LocaleSelectorHandle {
  focus(): void;
  dispose(): void;
}

export function mountLocaleSelector(
  host: HTMLElement,
  runtime: LocaleRuntime,
): LocaleSelectorHandle {
  const document = host.ownerDocument;
  ensureStyles(document);
  const controller = new AbortController();
  const wrapper = document.createElement("div");
  wrapper.className = "locale-selector";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "locale-trigger";
  trigger.id = "locale-selector-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "locale-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  wrapper.append(trigger, menu);
  host.replaceChildren(wrapper);

  let open = false;
  let activeIndex = 0;
  let current: LocaleSnapshot;
  const menuItems = (): HTMLButtonElement[] => [
    ...menu.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"),
  ];
  const selectedIndex = (): number =>
    current.preference === "system"
      ? 0
      : LOCALE_CODES.indexOf(current.preference) + 1;
  const focusItem = (index: number): void => {
    const items = menuItems();
    if (!items.length) return;
    activeIndex = (index + items.length) % items.length;
    items[activeIndex]?.focus();
  };
  const render = (snapshot: LocaleSnapshot): void => {
    current = snapshot;
    document.documentElement.lang = snapshot.locale;
    trigger.setAttribute(
      "aria-label",
      `${runtime.t("language.select")}: ${LOCALE_INFO[snapshot.locale].name}`,
    );
    trigger.setAttribute("title", LOCALE_INFO[snapshot.locale].name);
    trigger.replaceChildren(flagElement(document, snapshot.locale));
    menu.setAttribute("aria-label", runtime.t("language.select"));
    menu.replaceChildren(
      menuButton(
        document,
        "system",
        runtime.t("language.system"),
        snapshot.preference === "system",
      ),
      ...LOCALE_CODES.map((locale) =>
        menuButton(
          document,
          locale,
          LOCALE_INFO[locale].name,
          snapshot.preference === locale,
        ),
      ),
    );
    if (open) {
      trigger.setAttribute("aria-expanded", "true");
      menu.hidden = false;
    }
  };

  const close = (returnFocus: boolean): void => {
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    if (returnFocus) trigger.focus();
  };
  const openMenu = (index = selectedIndex()): void => {
    open = true;
    activeIndex = index;
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    focusItem(activeIndex);
  };
  const unsubscribe = runtime.subscribe(render);

  trigger.addEventListener("click", () => (open ? close(false) : openMenu()), {
    signal: controller.signal,
  });
  menu.addEventListener(
    "click",
    (event) => {
      const target = (
        event.target as Element | null
      )?.closest<HTMLButtonElement>("button[data-locale]");
      const locale = target?.dataset["locale"];
      if (
        locale === "system" ||
        (locale && LOCALE_CODES.includes(locale as LocaleCode))
      ) {
        runtime.select(locale as LocaleCode | "system");
        close(true);
      }
    },
    { signal: controller.signal },
  );
  wrapper.addEventListener(
    "keydown",
    (event) => {
      const key = (event as KeyboardEvent).key;
      if (
        [
          "Escape",
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Tab",
          "Enter",
          " ",
        ].includes(key)
      ) {
        event.stopPropagation();
      }
      if (key === "Escape" && open) {
        event.preventDefault();
        close(true);
        return;
      }
      if (key === "Tab" && open) {
        close(false);
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        if (!open)
          openMenu(key === "ArrowDown" ? selectedIndex() : selectedIndex());
        else focusItem(activeIndex + (key === "ArrowDown" ? 1 : -1));
      } else if (key === "Home" && open) {
        event.preventDefault();
        focusItem(0);
      } else if (key === "End" && open) {
        event.preventDefault();
        focusItem(menuItems().length - 1);
      }
    },
    { signal: controller.signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (open && !wrapper.contains(event.target as Node)) close(false);
    },
    { signal: controller.signal },
  );

  return {
    focus: () => trigger.focus(),
    dispose() {
      controller.abort();
      unsubscribe();
      host.replaceChildren();
    },
  };
}
