/** Adapter-owned prose only. Application/SDK diagnostics and machine keys are opaque. */
const messages = {
  missingValue: "missing value for {flag}",
  header: "--header requires K:V",
  timeout: "--timeout requires a number",
  duplicateRun: "Duplicate run option: {flag}",
  identity: "{flag} requires a nonempty identity without whitespace",
  unknownOption: "unknown option for {command}: {flag}",
  runArgs: "run accepts only one of --args or --args-file",
  usage: "usage: fmcad {usage}",
  document:
    "{command} requires --doc <name> (document commands always target an explicit document)",
  exactlyOne: "{command} requires exactly one of {flags}",
  direct:
    "routing=direct is no longer supported. Use the shared fmcad broker; routing=queue is accepted for compatibility.",
  unknownCommand: "unknown command: {command}",
  localFlags:
    'Local {command} options must follow "fmcad {command}"; backend/global flags are not supported.',
  diagnosticAlias: "diagnostic is an alias; use fmcad console.",
  noResult:
    "Execution ended without confirmed output. Observe the existing receipt; do not replay.",
  invalidOption: "Invalid {flag}",
  sequence:
    "Use --sequence-action begin, or continue/end with --sequence-id; sequence mode must be automatic or exclusive",
  addinReadonly:
    "WARNING: addin does not enforce a read-only sandbox; --readonly is a declaration only.",
} as const;
const polish: Partial<Record<keyof typeof messages, string>> = {
  missingValue: "brak wartości dla {flag}",
  header: "--header wymaga K:V",
  timeout: "--timeout wymaga liczby",
  duplicateRun: "Powtórzona opcja run: {flag}",
  identity: "{flag} wymaga niepustej tożsamości bez białych znaków",
  unknownOption: "nieznana opcja dla {command}: {flag}",
  runArgs: "run akceptuje tylko jedną z opcji --args lub --args-file",
  document:
    "{command} wymaga --doc <name> (polecenia dokumentu zawsze wskazują dokument jawnie)",
  exactlyOne: "{command} wymaga dokładnie jednej z opcji {flags}",
  direct:
    "routing=direct nie jest już obsługiwane. Użyj wspólnego brokera fmcad; routing=queue jest akceptowane dla zgodności.",
  unknownCommand: "nieznane polecenie: {command}",
  localFlags:
    'Opcje lokalne {command} muszą występować po "fmcad {command}"; flagi backend/global nie są obsługiwane.',
  diagnosticAlias: "diagnostic jest aliasem; używaj fmcad console.",
  noResult:
    "Wykonanie zakończyło się bez potwierdzonego wyniku. Odczytaj istniejący receipt; nie ponawiaj.",
  invalidOption: "Nieprawidłowa opcja {flag}",
  sequence:
    "Użyj --sequence-action begin albo continue/end z --sequence-id; tryb sekwencji musi być automatic lub exclusive",
  addinReadonly:
    "OSTRZEŻENIE: addin nie wymusza piaskownicy tylko do odczytu; --readonly jest wyłącznie deklaracją.",
};
export type MessageId = keyof typeof messages;
export class CliError extends Error {
  constructor(
    readonly messageId: MessageId,
    readonly argumentsValue: Readonly<Record<string, string>> = {},
  ) {
    super(renderMessage(messageId, argumentsValue));
    this.name = "CliError";
  }
}
export function renderMessage(
  id: MessageId,
  args: Readonly<Record<string, string>> = {},
  language = "en",
): string {
  const template =
    language === "pl" ? (polish[id] ?? messages[id]) : messages[id];
  return template.replace(
    /\{(\w+)\}/g,
    (match, key: string) => args[key] ?? match,
  );
}
