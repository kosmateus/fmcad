/// <reference lib="dom" />

type SelectOption = {
  readonly index: number;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly group: string | null;
};
type SelectEntry = {
  readonly id: string;
  readonly listboxId: string;
  readonly native: HTMLSelectElement;
  readonly wrapper: HTMLElement;
  readonly button: HTMLButtonElement;
  options: readonly SelectOption[];
  popup: HTMLElement | null;
  activeIndex: number;
  typeBuffer: string;
  typeAt: number;
};
type SelectApi = {
  readonly upgrade: (root?: ParentNode | null) => void;
  readonly close: (restoreFocus?: boolean) => void;
  readonly isOpen: () => boolean;
  readonly focus: (id: string | HTMLSelectElement) => void;
  readonly dispose: () => void;
};

const icon = (name: "down" | "check"): string =>
  `<svg class="icon small" viewBox="0 0 24 24" aria-hidden="true"><path d="${name === "down" ? "m6 9 6 6 6-6" : "m5 12 4 4L19 6"}"/></svg>`;
const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/** Native selects remain the data/control source; the visible UI preserves the prototype combobox. */
export function createSelectControls(): SelectApi {
  let serial = 0;
  let eventHandlersReady = false;
  let positionFrame = 0;
  let open: SelectEntry | null = null;
  const listeners = new AbortController();
  const entries = new Map<HTMLSelectElement, SelectEntry>();

  function portal(): HTMLElement | null {
    const root = document.getElementById("app");
    if (!root?.parentElement) return null;
    let result = root.parentElement.querySelector<HTMLElement>(
      "[data-floating-portal]",
    );
    if (!result) {
      result = document.createElement("div");
      result.className = "floating-portal";
      result.dataset["floatingPortal"] = "";
      root.parentElement.append(result);
    }
    return result;
  }

  function position(panel: HTMLElement, anchor: HTMLElement): void {
    if (!anchor.isConnected) return;
    const view = anchor.ownerDocument.defaultView ?? window;
    const visual = view.visualViewport;
    const viewport = {
      left: visual?.offsetLeft ?? 0,
      top: visual?.offsetTop ?? 0,
      width: visual?.width ?? view.innerWidth,
      height: visual?.height ?? view.innerHeight,
    };
    const box = anchor.getBoundingClientRect();
    const margin = 10;
    const gap = 7;
    const width = Math.max(
      140,
      Math.min(390, viewport.width - margin * 2, box.width),
    );
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(1, Math.min(312, viewport.height - margin * 2))}px`;
    const naturalHeight = Math.min(panel.scrollHeight, 312);
    const below = Math.max(
      0,
      viewport.top + viewport.height - margin - box.bottom - gap,
    );
    const above = Math.max(0, box.top - viewport.top - margin - gap);
    const placement = below < naturalHeight && above > below ? "top" : "bottom";
    const height = Math.max(
      1,
      Math.min(naturalHeight, placement === "top" ? above : below),
    );
    const x = Math.max(
      viewport.left + margin,
      Math.min(box.left, viewport.left + viewport.width - margin - width),
    );
    const y = placement === "top" ? box.top - gap - height : box.bottom + gap;
    panel.style.left = `${x}px`;
    panel.style.top = `${Math.max(viewport.top + margin, Math.min(y, viewport.top + viewport.height - margin - height))}px`;
    panel.style.maxHeight = `${height}px`;
    panel.dataset["placement"] = placement;
  }

  function options(native: HTMLSelectElement): SelectOption[] {
    return Array.from(native.options)
      .map((option, index) => ({
        index,
        value: option.value,
        label: option.label || option.textContent || "",
        disabled:
          option.disabled ||
          option.parentElement?.hasAttribute("disabled") === true,
        hidden:
          option.hidden === true ||
          option.parentElement?.hasAttribute("hidden") === true,
        group:
          option.parentElement?.tagName === "OPTGROUP"
            ? (option.parentElement.getAttribute("label") ?? "")
            : null,
      }))
      .filter((option) => !option.hidden);
  }

  function label(native: HTMLSelectElement): string {
    const names = Array.from(native.labels ?? [])
      .map((item) => item.textContent?.trim() ?? "")
      .filter(Boolean);
    return (
      native.getAttribute("aria-label") ||
      names.join(" ") ||
      native.name ||
      "Wybierz opcję"
    );
  }

  function sync(entry: SelectEntry): void {
    if (!entry.native.isConnected) return;
    entry.options = options(entry.native);
    const selected = entry.options.find(
      (item) => item.index === entry.native.selectedIndex,
    );
    const text = selected?.label || "Wybierz opcję";
    const value = entry.button.querySelector<HTMLElement>("[data-select-text]");
    if (value) value.textContent = text;
    entry.button.setAttribute("aria-label", `${label(entry.native)}: ${text}`);
    entry.button.disabled =
      entry.native.disabled || !entry.options.some((item) => !item.disabled);
    const described = entry.native.getAttribute("aria-describedby");
    if (described) entry.button.setAttribute("aria-describedby", described);
    else entry.button.removeAttribute("aria-describedby");
    entry.button.setAttribute(
      "aria-invalid",
      entry.native.getAttribute("aria-invalid") ?? "false",
    );
    entry.button.setAttribute(
      "aria-required",
      entry.native.required ? "true" : "false",
    );
  }

  function nextIndex(
    entry: SelectEntry,
    direction: number | "first" | "last",
  ): number {
    const enabled = entry.options.filter((item) => !item.disabled);
    if (!enabled.length) return -1;
    if (direction === "first") return enabled[0]!.index;
    if (direction === "last") return enabled.at(-1)!.index;
    const position = enabled.findIndex(
      (item) => item.index === entry.activeIndex,
    );
    if (position < 0)
      return direction < 0 ? enabled.at(-1)!.index : enabled[0]!.index;
    return enabled[
      Math.max(0, Math.min(enabled.length - 1, position + direction))
    ]!.index;
  }

  function findText(entry: SelectEntry, query: string): number {
    const normalize = (value: string): string =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("pl")
        .replace(/ł/g, "l");
    const needle = normalize(query);
    const enabled = entry.options.filter((item) => !item.disabled);
    const repeated = Array.from(needle).every((char) => char === needle[0]);
    const prefix = repeated ? (needle[0] ?? "") : needle;
    const current = enabled.findIndex(
      (item) => item.index === entry.activeIndex,
    );
    for (let step = 0; step < enabled.length; step++) {
      const item =
        enabled[
          (Math.max(current, 0) + step + (repeated ? 1 : 0)) % enabled.length
        ]!;
      if (normalize(item.label).startsWith(prefix)) return item.index;
    }
    return -1;
  }

  function close(restoreFocus = false): void {
    const entry = open;
    if (!entry) return;
    open = null;
    if (positionFrame) {
      cancelAnimationFrame(positionFrame);
      positionFrame = 0;
    }
    entry.popup?.remove();
    entry.popup = null;
    entry.button.setAttribute("aria-expanded", "false");
    entry.button.removeAttribute("aria-activedescendant");
    entry.button.removeAttribute("aria-owns");
    entry.wrapper.removeAttribute("data-open");
    entry.typeBuffer = "";
    if (restoreFocus && entry.button.isConnected && !entry.button.disabled)
      entry.button.focus({ preventScroll: true });
  }

  function highlight(entry: SelectEntry, index: number, scroll = true): void {
    const option = entry.options.find(
      (item) => item.index === index && !item.disabled,
    );
    if (!option || !entry.popup) return;
    entry.activeIndex = index;
    for (const node of entry.popup.querySelectorAll<HTMLElement>(
      "[data-select-option]",
    ))
      node.toggleAttribute(
        "data-active",
        Number(node.dataset["selectOption"]) === index,
      );
    const node = entry.popup.querySelector<HTMLElement>(
      `[data-select-option="${index}"]`,
    );
    if (!node) return;
    entry.button.setAttribute("aria-activedescendant", node.id);
    if (!scroll) return;
    if (node.offsetTop < entry.popup.scrollTop)
      entry.popup.scrollTop = node.offsetTop;
    else if (
      node.offsetTop + node.offsetHeight >
      entry.popup.scrollTop + entry.popup.clientHeight
    )
      entry.popup.scrollTop =
        node.offsetTop + node.offsetHeight - entry.popup.clientHeight;
  }

  function openMenu(entry: SelectEntry, edge?: "first" | "last"): void {
    if (!entry.native.isConnected || entry.button.disabled) return;
    if (open === entry) return;
    close();
    sync(entry);
    entry.typeBuffer = "";
    entry.typeAt = 0;
    const selected = entry.options.find(
      (item) => item.index === entry.native.selectedIndex && !item.disabled,
    );
    entry.activeIndex = edge
      ? nextIndex(entry, edge)
      : (selected?.index ?? nextIndex(entry, "first"));
    let group: string | null = null;
    const rows = entry.options
      .map((option) => {
        const groupHeading =
          option.group && option.group !== group
            ? `<div class="select-group" role="presentation">${escapeHtml(option.group)}</div>`
            : "";
        group = option.group;
        return `${groupHeading}<div class="select-option" role="option" id="${escapeHtml(entry.id)}--option-${option.index}" data-select-option="${option.index}" aria-selected="${option.index === entry.native.selectedIndex}" aria-disabled="${option.disabled}"><span class="select-option-label">${escapeHtml(option.label)}</span><span class="select-option-check" aria-hidden="true">${option.index === entry.native.selectedIndex ? icon("check") : ""}</span></div>`;
      })
      .join("");
    const popup = document.createElement("div");
    popup.className = "select-menu";
    popup.id = entry.listboxId;
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", label(entry.native));
    popup.tabIndex = -1;
    popup.innerHTML = rows;
    portal()?.append(popup);
    entry.popup = popup;
    open = entry;
    entry.wrapper.dataset["open"] = "";
    entry.button.setAttribute("aria-expanded", "true");
    entry.button.setAttribute("aria-owns", entry.listboxId);
    entry.button.focus({ preventScroll: true });
    position(popup, entry.button);
    highlight(entry, entry.activeIndex);
  }

  function commit(
    entry: SelectEntry,
    index: number,
    restoreFocus = true,
  ): void {
    const option = entry.options.find(
      (item) => item.index === index && !item.disabled,
    );
    if (!option) return;
    const changed = entry.native.selectedIndex !== index;
    entry.native.selectedIndex = index;
    close(restoreFocus);
    sync(entry);
    if (!changed) return;
    const EventConstructor =
      entry.native.ownerDocument.defaultView?.Event ?? Event;
    entry.native.dispatchEvent(
      new EventConstructor("input", { bubbles: true, composed: true }),
    );
    entry.native.dispatchEvent(
      new EventConstructor("change", { bubbles: true, composed: true }),
    );
  }

  function findEntry(target: EventTarget | null): SelectEntry | null {
    if (!(target instanceof Element)) return null;
    const native = target instanceof HTMLSelectElement ? target : null;
    if (native) return entries.get(native) ?? null;
    const wrapper = target.closest<HTMLElement>("[data-select-control]");
    return wrapper
      ? ([...entries.values()].find((entry) => entry.wrapper === wrapper) ??
          null)
      : null;
  }

  function reposition(): void {
    if (!open || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      if (!open?.button.isConnected || !open.popup) close();
      else position(open.popup, open.button);
    });
  }

  function keydown(event: KeyboardEvent): void {
    const entry =
      findEntry(event.target) ??
      (open?.popup?.contains(event.target as Node) ? open : null);
    if (!entry || event.ctrlKey || event.metaKey) return;
    const { key } = event;
    const isOpen = open === entry;
    if (key === "Tab") {
      if (isOpen) commit(entry, entry.activeIndex, false);
      return;
    }
    if (key === "Escape") {
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
      return;
    }
    if (event.altKey) {
      if (key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        openMenu(entry);
      } else if (key === "ArrowUp" && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      if (
        key === " " &&
        isOpen &&
        entry.typeBuffer &&
        Date.now() - entry.typeAt <= 700
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!isOpen) {
        openMenu(
          entry,
          key === "Home" ? "first" : key === "End" ? "last" : undefined,
        );
        return;
      }
      if (key === "Enter" || key === " ") commit(entry, entry.activeIndex);
      else
        highlight(
          entry,
          nextIndex(
            entry,
            key === "Home"
              ? "first"
              : key === "End"
                ? "last"
                : key === "ArrowUp"
                  ? -1
                  : 1,
          ),
        );
      return;
    }
    if (key.length !== 1 || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isOpen) openMenu(entry);
    if (open !== entry) return;
    const now = Date.now();
    entry.typeBuffer = now - entry.typeAt > 700 ? key : entry.typeBuffer + key;
    entry.typeAt = now;
    const index = findText(entry, entry.typeBuffer);
    if (index >= 0) highlight(entry, index);
  }

  function ensureEvents(): void {
    if (eventHandlersReady) return;
    eventHandlersReady = true;
    const capture: AddEventListenerOptions = {
      capture: true,
      signal: listeners.signal,
    };
    document.addEventListener("keydown", keydown, capture);
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!open) return;
        if (open.popup?.contains(event.target as Node)) {
          if ((event.target as Element).closest("[data-select-option]"))
            event.preventDefault();
        } else if (!open.wrapper.contains(event.target as Node)) close();
      },
      capture,
    );
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const option = target.closest<HTMLElement>("[data-select-option]");
        if (option && open?.popup?.contains(option)) {
          event.preventDefault();
          event.stopPropagation();
          commit(open, Number(option.dataset["selectOption"]));
          return;
        }
        const trigger = target.closest<HTMLElement>("[data-select-trigger]");
        const entry = trigger ? findEntry(trigger) : null;
        if (entry) {
          event.preventDefault();
          event.stopPropagation();
          if (open === entry) close(true);
          else openMenu(entry);
          return;
        }
        const controlLabel = target.closest<HTMLLabelElement>("label");
        const select = controlLabel?.control;
        const linked =
          select instanceof HTMLSelectElement ? entries.get(select) : null;
        if (linked) {
          event.preventDefault();
          linked.button.focus({ preventScroll: true });
        }
      },
      capture,
    );
    document.addEventListener(
      "pointermove",
      (event) => {
        if (!(event.target instanceof Element)) return;
        const option = event.target.closest<HTMLElement>(
          "[data-select-option]",
        );
        if (
          option &&
          open?.popup?.contains(option) &&
          event.pointerType !== "touch"
        )
          highlight(open, Number(option.dataset["selectOption"]), false);
      },
      capture,
    );
    document.addEventListener(
      "focusin",
      (event) => {
        if (
          event.target instanceof HTMLSelectElement &&
          entries.has(event.target)
        ) {
          entries.get(event.target)!.button.focus({ preventScroll: true });
          return;
        }
        if (
          open &&
          !open.wrapper.contains(event.target as Node) &&
          !open.popup?.contains(event.target as Node)
        )
          close();
      },
      capture,
    );
    document.addEventListener(
      "change",
      (event) => {
        if (event.target instanceof HTMLSelectElement) {
          const entry = entries.get(event.target);
          if (entry) sync(entry);
        }
      },
      capture,
    );
    document.addEventListener(
      "scroll",
      (event) => {
        if (open?.popup?.contains(event.target as Node)) return;
        reposition();
      },
      true,
    );
    window.addEventListener("resize", reposition, { signal: listeners.signal });
    window.addEventListener("blur", () => close(), {
      signal: listeners.signal,
    });
    window.visualViewport?.addEventListener("resize", reposition, {
      signal: listeners.signal,
    });
    window.visualViewport?.addEventListener("scroll", reposition, {
      signal: listeners.signal,
    });
  }

  function upgrade(
    root: ParentNode | null = document.getElementById("app"),
  ): void {
    if (!root) return;
    ensureEvents();
    for (const [native, entry] of entries) {
      if (!native.isConnected) {
        if (open === entry) close();
        entries.delete(native);
      }
    }
    const selects =
      root instanceof HTMLSelectElement
        ? [root]
        : [...root.querySelectorAll<HTMLSelectElement>("select")];
    for (const native of selects) {
      if (native.multiple || Number(native.size) > 1) continue;
      const existing = entries.get(native);
      if (existing) {
        sync(existing);
        continue;
      }
      const measuredWidth = native.getBoundingClientRect().width;
      if (!native.id) native.id = `fmcad-select-${++serial}`;
      const id = native.id;
      const mount = document.createElement("span");
      mount.innerHTML = `<span class="select-control" data-select-control><button class="select-trigger" type="button" id="${escapeHtml(id)}--trigger" data-select-trigger role="combobox" aria-haspopup="listbox" aria-controls="${escapeHtml(id)}--listbox" aria-expanded="false" aria-autocomplete="none"><span class="select-value" data-select-text></span><span class="select-chevron" aria-hidden="true">${icon("down")}</span></button></span>`;
      const wrapper = mount.firstElementChild as HTMLElement;
      if (measuredWidth > 0)
        wrapper.style.width = `${Math.ceil(measuredWidth)}px`;
      native.parentNode?.insertBefore(wrapper, native);
      wrapper.insertBefore(native, wrapper.firstChild);
      native.setAttribute("data-select-native", "");
      native.setAttribute("aria-hidden", "true");
      native.tabIndex = -1;
      const button = wrapper.querySelector<HTMLButtonElement>(
        "[data-select-trigger]",
      )!;
      const entry: SelectEntry = {
        id,
        listboxId: `${id}--listbox`,
        native,
        wrapper,
        button,
        options: [],
        popup: null,
        activeIndex: -1,
        typeBuffer: "",
        typeAt: 0,
      };
      entries.set(native, entry);
      sync(entry);
    }
  }

  return {
    upgrade,
    close,
    isOpen: () => open !== null,
    focus: (id) => {
      const native = typeof id === "string" ? document.getElementById(id) : id;
      const entry =
        native instanceof HTMLSelectElement ? entries.get(native) : null;
      (entry?.button ?? native)?.focus({ preventScroll: true });
    },
    dispose: () => {
      close();
      listeners.abort();
      entries.clear();
      eventHandlersReady = false;
    },
  };
}
