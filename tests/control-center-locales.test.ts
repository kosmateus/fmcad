import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
const root = path.resolve(__dirname, "../..");
const { CATALOGS, ENGLISH_CATALOG, LOCALE_CODES } = require(
  path.join(root, "packages/control-center/dist/web/locale-catalogs.js"),
) as typeof import("../packages/control-center/dist/web/locale-catalogs.js");
const { createLocaleRuntime, LOCALE_STORAGE_KEY } = require(
  path.join(root, "packages/control-center/dist/web/locale-runtime.js"),
) as typeof import("../packages/control-center/dist/web/locale-runtime.js");

test("every archived locale preserves message keys and interpolation arguments", () => {
  const keys = Object.keys(ENGLISH_CATALOG).sort();
  const placeholders = (value: string) =>
    [...value.matchAll(/\{([\w.]+)\}/gu)].map((match) => match[1]).sort();
  for (const locale of LOCALE_CODES) {
    assert.deepEqual(Object.keys(CATALOGS[locale]).sort(), keys, locale);
    for (const key of keys as (keyof typeof ENGLISH_CATALOG)[]) {
      const english = ENGLISH_CATALOG[key];
      const translated = CATALOGS[locale][key];
      const expected = placeholders(
        typeof english === "string" ? english : english.other!,
      );
      for (const form of typeof translated === "string"
        ? [translated]
        : Object.values(translated)) {
        assert.deepEqual(placeholders(form), expected, `${locale}: ${key}`);
      }
    }
  }
});

test("locale follows system, persists explicit selection, resets and disposes subscriptions", () => {
  const data = new Map<string, string>();
  let languages = ["pl-PL"];
  let languageChange: (() => void) | undefined;
  const runtime = createLocaleRuntime({
    getLanguages: () => languages,
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    },
    onLanguageChange: (listener) => {
      languageChange = listener;
      return () => {
        languageChange = undefined;
      };
    },
  });
  let changes = 0;
  const unsubscribe = runtime.subscribe(() => {
    changes++;
  });
  assert.equal(runtime.locale, "pl");
  runtime.select("de");
  assert.equal(runtime.t("ui.page.overview.global.title"), "Globale Übersicht");
  assert.equal(data.get(LOCALE_STORAGE_KEY), "de");
  languages = ["fr-FR"];
  languageChange?.();
  assert.equal(runtime.locale, "de");
  runtime.select("system");
  assert.equal(runtime.locale, "fr");
  assert.equal(data.has(LOCALE_STORAGE_KEY), false);
  unsubscribe();
  const before = changes;
  runtime.select("pl");
  assert.equal(changes, before);
  runtime.dispose();
  assert.equal(languageChange, undefined);
});

// Key/placeholder parity alone cannot detect a shifted positional translation.
test("localized filters and search preserve the meaning of their actions", () => {
  const expectations = {
    pl: {
      "ui.filter.empty": "Brak pasujących wartości.",
      "ui.filter.invalidRange":
        "Podaj poprawny zakres: minimum nie może być większe od maksimum.",
      "ui.search.placeholder": "Projekt, zadanie, agent, ID…",
      "ui.search.prompt": "Wpisz wyszukiwaną frazę",
      "ui.search.apiOnly":
        "Wyszukiwanie korzysta wyłącznie z danych dostępnych przez API.",
      "ui.search.globalScope": "Odczyt globalnego zakresu.",
      "ui.search.emptyDescription": "Spróbuj innej nazwy lub fragmentu.",
      "ui.search.unavailable": "Wyszukiwanie niedostępne",
      "ui.help.shortcuts.taskCodeResponse": "Kod / Odpowiedź",
    },
    de: {
      "ui.filter.empty": "Keine passenden Werte.",
      "ui.filter.invalidRange":
        "Geben Sie einen gültigen Bereich ein: Das Minimum darf das Maximum nicht überschreiten.",
      "ui.search.placeholder": "Projekt, Aufgabe, Agent, ID…",
      "ui.search.prompt": "Suchbegriff eingeben",
      "ui.search.apiOnly":
        "Die Suche verwendet nur über die API verfügbare Daten.",
      "ui.search.globalScope": "Globalen Bereich lesen.",
      "ui.search.emptyDescription":
        "Versuchen Sie einen anderen Namen oder Ausschnitt.",
      "ui.search.unavailable": "Suche nicht verfügbar",
      "ui.help.shortcuts.taskCodeResponse": "Code / Antwort",
    },
  } as const;
  for (const locale of ["pl", "de"] as const) {
    for (const [key, expected] of Object.entries(expectations[locale])) {
      assert.equal(
        CATALOGS[locale][key as keyof typeof ENGLISH_CATALOG],
        expected,
        `${locale}: ${key}`,
      );
    }
  }
});

test("translated copy and navigation actions keep their distinct meanings", () => {
  const pl = CATALOGS.pl;
  const de = CATALOGS.de;
  assert.equal(pl["ui.modal.copyEntry"], "Kopiuj wpis");
  assert.equal(pl["ui.modal.backToTask"], "← Zadanie");
  assert.equal(de["ui.modal.copyEntry"], "Eintrag kopieren");
  assert.equal(de["ui.modal.backToTask"], "← Aufgabe");
});
