import {
  CATALOGS,
  ENGLISH_CATALOG,
  LOCALE_CODES,
  type LocaleCode,
  type MessageKey,
  type MessageValue,
  type PluralCategory,
} from "./locale-catalogs.js";

export const LOCALE_STORAGE_KEY = "fmcad.control-center.locale.v1";
export type LocalePreference = LocaleCode | "system";

export interface LocaleSnapshot {
  readonly locale: LocaleCode;
  readonly preference: LocalePreference;
  readonly systemLocale: LocaleCode;
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocaleRuntimeOptions {
  readonly getLanguages?: () => readonly string[];
  readonly storage?: LocaleStorage | null;
  readonly onLanguageChange?: (listener: () => void) => () => void;
}

export interface LocaleRuntime {
  readonly locale: LocaleCode;
  readonly preference: LocalePreference;
  readonly systemLocale: LocaleCode;
  select(preference: LocalePreference): void;
  subscribe(listener: (snapshot: LocaleSnapshot) => void): () => void;
  t(
    key: MessageKey,
    params?: Readonly<Record<string, string | number>>,
  ): string;
  plural(
    key: MessageKey,
    count: number,
    params?: Readonly<Record<string, string | number>>,
  ): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  formatDuration(milliseconds: number): string;
  dispose(): void;
}

const supported = new Set<string>(LOCALE_CODES);
const isLocaleCode = (value: unknown): value is LocaleCode =>
  typeof value === "string" && supported.has(value);

export function matchLocaleTag(tag: string): LocaleCode | null {
  if (typeof tag !== "string" || tag.length === 0) return null;
  let normalized: string;
  try {
    normalized = Intl.getCanonicalLocales(tag.replaceAll("_", "-"))[0] ?? "";
  } catch {
    return null;
  }
  const language = normalized.split("-", 1)[0]?.toLowerCase();
  return language && isLocaleCode(language) ? language : null;
}

export function resolveSystemLocale(languages: readonly string[]): LocaleCode {
  for (const language of languages) {
    const match = matchLocaleTag(language);
    if (match) return match;
  }
  return "en";
}

function browserLanguages(): readonly string[] {
  try {
    if (typeof navigator === "undefined") return [];
    return navigator.languages?.length
      ? [...navigator.languages]
      : navigator.language
        ? [navigator.language]
        : [];
  } catch {
    return [];
  }
}

function browserStorage(): LocaleStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function languageChangeSubscription(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("languagechange", listener);
  return () => window.removeEventListener("languagechange", listener);
}

function readPreference(storage: LocaleStorage | null): LocalePreference {
  if (!storage) return "system";
  try {
    const value = storage.getItem(LOCALE_STORAGE_KEY);
    if (value === null) return "system";
    if (isLocaleCode(value)) return value;
    try {
      storage.removeItem(LOCALE_STORAGE_KEY);
    } catch {
      // A blocked storage backend only disables persistence, not locale selection.
    }
  } catch {
    // Browser privacy settings may deny storage access.
  }
  return "system";
}

const categories: readonly PluralCategory[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
];

function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>>,
  locale: LocaleCode,
): string {
  return template.replace(/\{([\w.]+)\}/gu, (placeholder, name: string) => {
    const value = params[name];
    if (typeof value === "number")
      return new Intl.NumberFormat(locale).format(value);
    return typeof value === "string" ? value : placeholder;
  });
}

function selectMessage(
  value: MessageValue,
  locale: LocaleCode,
  count?: number,
): string {
  if (typeof value === "string") return value;
  const category =
    count === undefined
      ? "other"
      : (new Intl.PluralRules(locale).select(count) as PluralCategory);
  const candidates: readonly PluralCategory[] = [
    category,
    "other",
    ...categories,
  ];
  for (const candidate of candidates) {
    const message = value[candidate];
    if (message) return message;
  }
  return "";
}

export function createLocaleRuntime(
  options: LocaleRuntimeOptions = {},
): LocaleRuntime {
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  const getLanguages = options.getLanguages ?? browserLanguages;
  const listenForLanguageChange =
    options.onLanguageChange ?? languageChangeSubscription;
  let systemLocale = resolveSystemLocale(getLanguages());
  let preference = readPreference(storage);
  let locale: LocaleCode = preference === "system" ? systemLocale : preference;
  const listeners = new Set<(snapshot: LocaleSnapshot) => void>();
  let disposed = false;

  const snapshot = (): LocaleSnapshot => ({ locale, preference, systemLocale });
  const emit = (): void => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  const unsubscribeLanguageChange = listenForLanguageChange(() => {
    systemLocale = resolveSystemLocale(getLanguages());
    if (preference === "system") {
      locale = systemLocale;
      emit();
    }
  });

  const runtime: LocaleRuntime = {
    get locale() {
      return locale;
    },
    get preference() {
      return preference;
    },
    get systemLocale() {
      return systemLocale;
    },
    select(nextPreference) {
      preference = nextPreference;
      locale = nextPreference === "system" ? systemLocale : nextPreference;
      if (storage) {
        try {
          if (nextPreference === "system")
            storage.removeItem(LOCALE_STORAGE_KEY);
          else storage.setItem(LOCALE_STORAGE_KEY, nextPreference);
        } catch {
          // Keep the in-memory selection when persistence is denied.
        }
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    t(key, params = {}) {
      const message = CATALOGS[locale][key] ?? ENGLISH_CATALOG[key];
      const count =
        typeof params["count"] === "number" ? params["count"] : undefined;
      return interpolate(selectMessage(message, locale, count), params, locale);
    },
    plural(key, count, params = {}) {
      const message = CATALOGS[locale][key] ?? ENGLISH_CATALOG[key];
      return interpolate(
        selectMessage(message, locale, count),
        { ...params, count },
        locale,
      );
    },
    formatNumber(value, formatOptions) {
      return new Intl.NumberFormat(locale, formatOptions).format(value);
    },
    formatDate(
      value,
      formatOptions = { dateStyle: "medium", timeStyle: "short" },
    ) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return runtime.t("common.unknown");
      return new Intl.DateTimeFormat(locale, formatOptions).format(date);
    },
    formatDuration(milliseconds) {
      if (!Number.isFinite(milliseconds)) return runtime.t("common.unknown");
      const absolute = Math.abs(milliseconds);
      const [unit, amount] =
        absolute < 1_000
          ? (["millisecond", milliseconds] as const)
          : absolute < 60_000
            ? (["second", milliseconds / 1_000] as const)
            : absolute < 3_600_000
              ? (["minute", milliseconds / 60_000] as const)
              : (["hour", milliseconds / 3_600_000] as const);
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(amount);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeLanguageChange();
      listeners.clear();
    },
  };

  return runtime;
}

export const localeText = createLocaleRuntime();
