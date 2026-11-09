export const LOCALE_CODES = [
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "ga",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "uk",
] as const;

export type LocaleCode = (typeof LOCALE_CODES)[number];
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessage = Readonly<Partial<Record<PluralCategory, string>>>;
export type MessageValue = string | PluralMessage;
