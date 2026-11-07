import type { LocaleCode, MessageValue } from "./locale-catalogs.js";

export const ENGLISH_SYSTEM_CONTROL_CATALOG = {
  "system.controls.title": "Shared broker control.",
  "system.controls.confirm.cancel": "Cancel",
  "system.controls.scope.project":
    "This is global control for the one shared broker; it affects every project, including {projectName}.",
  "system.controls.scope.managedOnly":
    "Pausing stops new fmcad-managed requests only. It does not stop Fusion or unrelated applications.",
  "system.controls.status.label": "Broker status.",
  "system.controls.phase.running": "Accepting managed requests.",
  "system.controls.phase.paused": "Paused. New managed requests are held.",
  "system.controls.phase.pausing":
    "Pausing; active managed requests may still be running.",
  "system.controls.phase.draining":
    "Draining; waiting for {activeOperations} active managed requests.",
  "system.controls.phase.stopped": "Stopped.",
  "system.controls.phase.unknown": "Broker state is unknown.",
  "system.controls.phase.recoveryBlocked":
    "Unresolved broker work requires reconciliation; controls are disabled.",
  "system.controls.phase.offline":
    "Broker is offline; current state is unavailable.",
  "system.controls.action.pause": "Stop accepting requests.",
  "system.controls.action.drain": "Pause and drain active requests.",
  "system.controls.action.resume": "Resume accepting requests.",
  "system.controls.action.start": "Start broker.",
  "system.controls.action.refresh": "Refresh broker status.",
  "system.controls.action.reconcile": "Check original request.",
  "system.controls.action.pending": "Waiting for broker confirmation.",
  "system.controls.action.confirmed": "Broker confirmed {phase}.",
  "system.controls.action.unknown":
    "Outcome unknown. Checking the original receipt; the action will not be sent again.",
  "system.controls.action.receiptPending":
    "The original request is pending. Checking its receipt; no second action will be sent.",
  "system.controls.safety.noReplay":
    "Do not repeat an action while its receipt is pending or unknown.",
  "system.controls.error.unauthorized":
    "You are not authorized to control the shared broker.",
  "system.controls.error.storageUnavailable":
    "Persistent browser storage is unavailable. Controls are disabled to prevent replay.",
  "system.controls.error.unsupported":
    "{action} is not supported by this broker.",
  "system.controls.error.offline":
    "The broker is offline. No action was confirmed.",
  "system.controls.error.generationConflict":
    "Broker state changed after it was read; no action was applied.",
  "system.controls.error.instanceChanged":
    "The broker instance changed. Refresh status before acting.",
  "system.controls.error.reconciliationRequired":
    "The broker has unresolved work. Resume and start are disabled until it is reconciled.",
  "system.controls.error.capabilityUnavailable":
    "This control is unavailable: {reason}.",
  "system.controls.accessible.status": "Shared broker control status.",
  "system.controls.accessible.globalScope":
    "Applies globally to managed requests from all projects.",
  "system.controls.accessible.pending":
    "Waiting for authoritative broker receipt.",
  "system.controls.accessible.action": "{action} shared broker.",
  "system.controls.accessible.disabled": "{action} unavailable: {reason}.",
} as const;

export type SystemControlMessageKey =
  keyof typeof ENGLISH_SYSTEM_CONTROL_CATALOG;
export type SystemControlCatalog = Readonly<
  Record<SystemControlMessageKey, MessageValue>
>;

const systemControlCatalogs = {
  bg: {
    "system.controls.title": "Споделено управление на брокера.",
    "system.controls.scope.project":
      "Това е глобално управление за единствения споделен брокер; засяга всички проекти, включително {projectName}.",
    "system.controls.scope.managedOnly":
      "Поставянето на пауза спира само новите заявки, управлявани от fmcad. То не спира Fusion или други приложения.",
    "system.controls.status.label": "Състояние на брокера.",
    "system.controls.phase.running": "Приема управлявани заявки.",
    "system.controls.phase.paused":
      "На пауза. Новите управлявани заявки се задържат.",
    "system.controls.phase.pausing":
      "Поставя се на пауза; активните управлявани заявки може още да се изпълняват.",
    "system.controls.phase.draining":
      "Изчаква приключване; изчакват се {activeOperations} активни управлявани заявки.",
    "system.controls.phase.stopped": "Спрян.",
    "system.controls.phase.unknown": "Състоянието на брокера е неизвестно.",
    "system.controls.phase.recoveryBlocked":
      "Неразрешена работа на брокера изисква съгласуване; управлението е изключено.",
    "system.controls.phase.offline":
      "Брокерът е извън линия; текущото състояние не е налично.",
    "system.controls.action.pause": "Спрете приемането на заявки.",
    "system.controls.action.drain":
      "Поставете на пауза и изчакайте активните заявки.",
    "system.controls.action.resume": "Подновете приемането на заявки.",
    "system.controls.action.start": "Стартирайте брокера.",
    "system.controls.action.refresh": "Обновете състоянието на брокера.",
    "system.controls.action.reconcile": "Проверете първоначалната заявка.",
    "system.controls.action.pending": "Изчаква се потвърждение от брокера.",
    "system.controls.action.confirmed": "Брокерът потвърди: {phase}.",
    "system.controls.action.unknown":
      "Резултатът е неизвестен. Проверява се първоначалната разписка; действието няма да бъде изпратено отново.",
    "system.controls.action.receiptPending":
      "Първоначалната заявка все още се обработва. Проверява се разписката ѝ; няма да бъде изпратено второ действие.",
    "system.controls.safety.noReplay":
      "Не повтаряйте действие, докато разписката му се обработва или резултатът е неизвестен.",
    "system.controls.error.unauthorized":
      "Нямате право да управлявате споделения брокер.",
    "system.controls.error.storageUnavailable":
      "Постоянното съхранение в браузъра не е налично. Управлението е изключено, за да се предотврати повторно изпращане.",
    "system.controls.error.unsupported":
      "Този брокер не поддържа действието: {action}.",
    "system.controls.error.offline":
      "Брокерът е извън линия. Не е потвърдено действие.",
    "system.controls.error.generationConflict":
      "Състоянието на брокера се промени след прочитането; не е приложено действие.",
    "system.controls.error.instanceChanged":
      "Екземплярът на брокера се промени. Обновете състоянието, преди да действате.",
    "system.controls.error.reconciliationRequired":
      "Брокерът има неразрешена работа. Подновяването и стартирането са изключени до съгласуването ѝ.",
    "system.controls.error.capabilityUnavailable":
      "Това управление не е налично: {reason}.",
    "system.controls.accessible.status":
      "Състояние на споделеното управление на брокера.",
    "system.controls.accessible.globalScope":
      "Прилага се глобално към управляваните заявки от всички проекти.",
    "system.controls.accessible.pending":
      "Изчаква се официална разписка от брокера.",
    "system.controls.accessible.action": "{action} споделения брокер.",
    "system.controls.accessible.disabled": "{action} не е налично: {reason}.",
  },
  hr: {
    "system.controls.title": "Upravljanje zajedničkim brokerom.",
    "system.controls.scope.project":
      "Ovo je globalno upravljanje jednim zajedničkim brokerom; utječe na sve projekte, uključujući {projectName}.",
    "system.controls.scope.managedOnly":
      "Pauziranje zaustavlja samo nove zahtjeve kojima upravlja fmcad. Ne zaustavlja Fusion ni druge aplikacije.",
    "system.controls.status.label": "Status brokera.",
    "system.controls.phase.running": "Prihvaća upravljane zahtjeve.",
    "system.controls.phase.paused":
      "Pauzirano. Novi upravljani zahtjevi čekaju.",
    "system.controls.phase.pausing":
      "Pauziranje; aktivni upravljani zahtjevi možda se još izvršavaju.",
    "system.controls.phase.draining":
      "Pražnjenje; čeka se {activeOperations} aktivnih upravljanih zahtjeva.",
    "system.controls.phase.stopped": "Zaustavljeno.",
    "system.controls.phase.unknown": "Stanje brokera nije poznato.",
    "system.controls.phase.recoveryBlocked":
      "Nerazriješeni posao brokera treba uskladiti; kontrole su onemogućene.",
    "system.controls.phase.offline":
      "Broker nije povezan; trenutačno stanje nije dostupno.",
    "system.controls.action.pause": "Zaustavi prihvaćanje zahtjeva.",
    "system.controls.action.drain":
      "Pauziraj i pričekaj završetak aktivnih zahtjeva.",
    "system.controls.action.resume": "Nastavi prihvaćati zahtjeve.",
    "system.controls.action.start": "Pokreni broker.",
    "system.controls.action.refresh": "Osvježi status brokera.",
    "system.controls.action.reconcile": "Provjeri izvorni zahtjev.",
    "system.controls.action.pending": "Čeka se potvrda brokera.",
    "system.controls.action.confirmed": "Broker je potvrdio: {phase}.",
    "system.controls.action.unknown":
      "Ishod nije poznat. Provjerava se izvorna potvrda; radnja se neće ponovno poslati.",
    "system.controls.action.receiptPending":
      "Izvorni zahtjev još čeka. Provjerava se potvrda; druga radnja neće biti poslana.",
    "system.controls.safety.noReplay":
      "Ne ponavljaj radnju dok njezina potvrda čeka ili je ishod nepoznat.",
    "system.controls.error.unauthorized":
      "Niste ovlašteni upravljati zajedničkim brokerom.",
    "system.controls.error.storageUnavailable":
      "Trajna pohrana preglednika nije dostupna. Upravljanje je onemogućeno kako bi se spriječilo ponavljanje radnje.",
    "system.controls.error.unsupported":
      "Ovaj broker ne podržava radnju {action}.",
    "system.controls.error.offline":
      "Broker nije povezan. Nijedna radnja nije potvrđena.",
    "system.controls.error.generationConflict":
      "Stanje brokera promijenilo se nakon čitanja; radnja nije primijenjena.",
    "system.controls.error.instanceChanged":
      "Instanca brokera promijenila se. Osvježi status prije djelovanja.",
    "system.controls.error.reconciliationRequired":
      "Broker ima nerazriješen posao. Nastavljanje i pokretanje onemogućeni su dok se ne uskladi.",
    "system.controls.error.capabilityUnavailable":
      "Ova kontrola nije dostupna: {reason}.",
    "system.controls.accessible.status":
      "Status upravljanja zajedničkim brokerom.",
    "system.controls.accessible.globalScope":
      "Globalno se primjenjuje na upravljane zahtjeve iz svih projekata.",
    "system.controls.accessible.pending": "Čeka se mjerodavna potvrda brokera.",
    "system.controls.accessible.action": "{action} zajednički broker.",
    "system.controls.accessible.disabled":
      "Radnja {action} nije dostupna: {reason}.",
  },
  cs: {
    "system.controls.title": "Ovládání sdíleného brokeru.",
    "system.controls.scope.project":
      "Jde o globální ovládání jediného sdíleného brokeru; ovlivňuje všechny projekty včetně {projectName}.",
    "system.controls.scope.managedOnly":
      "Pozastavení zastaví pouze nové požadavky spravované fmcad. Nezastaví Fusion ani jiné aplikace.",
    "system.controls.status.label": "Stav brokeru.",
    "system.controls.phase.running": "Přijímá spravované požadavky.",
    "system.controls.phase.paused":
      "Pozastaveno. Nové spravované požadavky čekají.",
    "system.controls.phase.pausing":
      "Pozastavuje se; aktivní spravované požadavky mohou stále běžet.",
    "system.controls.phase.draining":
      "Dokončují se požadavky; čeká se na {activeOperations} aktivních spravovaných požadavků.",
    "system.controls.phase.stopped": "Zastaveno.",
    "system.controls.phase.unknown": "Stav brokeru není znám.",
    "system.controls.phase.recoveryBlocked":
      "Nevyřešená práce brokeru vyžaduje vypořádání; ovládací prvky jsou zakázány.",
    "system.controls.phase.offline":
      "Broker je offline; aktuální stav není dostupný.",
    "system.controls.action.pause": "Přestat přijímat požadavky.",
    "system.controls.action.drain": "Pozastavit a dokončit aktivní požadavky.",
    "system.controls.action.resume": "Obnovit přijímání požadavků.",
    "system.controls.action.start": "Spustit broker.",
    "system.controls.action.refresh": "Obnovit stav brokeru.",
    "system.controls.action.reconcile": "Zkontrolovat původní požadavek.",
    "system.controls.action.pending": "Čeká se na potvrzení brokeru.",
    "system.controls.action.confirmed": "Broker potvrdil: {phase}.",
    "system.controls.action.unknown":
      "Výsledek není znám. Kontroluje se původní potvrzení; akce se znovu neodešle.",
    "system.controls.action.receiptPending":
      "Původní požadavek čeká. Kontroluje se jeho potvrzení; druhá akce se neodešle.",
    "system.controls.safety.noReplay":
      "Neopakujte akci, dokud čeká její potvrzení nebo není znám její výsledek.",
    "system.controls.error.unauthorized":
      "Nemáte oprávnění ovládat sdílený broker.",
    "system.controls.error.storageUnavailable":
      "Trvalé úložiště prohlížeče není dostupné. Ovládání je zakázáno, aby se předešlo opakování akce.",
    "system.controls.error.unsupported":
      "Tento broker nepodporuje akci {action}.",
    "system.controls.error.offline":
      "Broker je offline. Žádná akce nebyla potvrzena.",
    "system.controls.error.generationConflict":
      "Stav brokeru se po přečtení změnil; akce nebyla použita.",
    "system.controls.error.instanceChanged":
      "Instance brokeru se změnila. Před akcí obnovte stav.",
    "system.controls.error.reconciliationRequired":
      "Broker má nevyřešenou práci. Obnovení a spuštění jsou zakázány, dokud nebude vyřešena.",
    "system.controls.error.capabilityUnavailable":
      "Toto ovládání není dostupné: {reason}.",
    "system.controls.accessible.status": "Stav ovládání sdíleného brokeru.",
    "system.controls.accessible.globalScope":
      "Globálně se vztahuje na spravované požadavky ze všech projektů.",
    "system.controls.accessible.pending":
      "Čeká se na autoritativní potvrzení brokeru.",
    "system.controls.accessible.action": "{action} sdílený broker.",
    "system.controls.accessible.disabled":
      "Akce {action} není dostupná: {reason}.",
  },
  da: {
    "system.controls.title": "Styring af delt broker.",
    "system.controls.scope.project":
      "Dette er global styring af den ene delte broker; det påvirker alle projekter, herunder {projectName}.",
    "system.controls.scope.managedOnly":
      "Pause stopper kun nye fmcad-styrede anmodninger. Det stopper ikke Fusion eller andre programmer.",
    "system.controls.status.label": "Brokerstatus.",
    "system.controls.phase.running": "Modtager styrede anmodninger.",
    "system.controls.phase.paused":
      "Sat på pause. Nye styrede anmodninger holdes tilbage.",
    "system.controls.phase.pausing":
      "Sætter på pause; aktive styrede anmodninger kan stadig køre.",
    "system.controls.phase.draining":
      "Afvikler; venter på {activeOperations} aktive styrede anmodninger.",
    "system.controls.phase.stopped": "Stoppet.",
    "system.controls.phase.unknown": "Brokerens tilstand er ukendt.",
    "system.controls.phase.recoveryBlocked":
      "Uafklaret brokerarbejde kræver afstemning; styring er deaktiveret.",
    "system.controls.phase.offline":
      "Broker er offline; den aktuelle tilstand er ikke tilgængelig.",
    "system.controls.action.pause": "Stop med at modtage anmodninger.",
    "system.controls.action.drain":
      "Sæt på pause, og afvikl aktive anmodninger.",
    "system.controls.action.resume": "Genoptag modtagelse af anmodninger.",
    "system.controls.action.start": "Start broker.",
    "system.controls.action.refresh": "Opdater brokerstatus.",
    "system.controls.action.reconcile": "Kontrollér den oprindelige anmodning.",
    "system.controls.action.pending": "Venter på bekræftelse fra broker.",
    "system.controls.action.confirmed": "Broker bekræftede {phase}.",
    "system.controls.action.unknown":
      "Resultatet er ukendt. Kontrollerer den oprindelige kvittering; handlingen sendes ikke igen.",
    "system.controls.action.receiptPending":
      "Den oprindelige anmodning afventer. Kontrollerer dens kvittering; ingen ny handling sendes.",
    "system.controls.safety.noReplay":
      "Gentag ikke en handling, mens kvitteringen afventes, eller resultatet er ukendt.",
    "system.controls.error.unauthorized":
      "Du har ikke tilladelse til at styre den delte broker.",
    "system.controls.error.storageUnavailable":
      "Vedvarende browserlager er ikke tilgængeligt. Styring er deaktiveret for at forhindre gentagelse af handlingen.",
    "system.controls.error.unsupported":
      "Denne broker understøtter ikke {action}.",
    "system.controls.error.offline":
      "Broker er offline. Ingen handling blev bekræftet.",
    "system.controls.error.generationConflict":
      "Brokerens tilstand ændrede sig efter aflæsningen; ingen handling blev udført.",
    "system.controls.error.instanceChanged":
      "Brokerinstansen er ændret. Opdater status, før du handler.",
    "system.controls.error.reconciliationRequired":
      "Broker har uafklaret arbejde. Genoptagelse og start er deaktiveret, indtil det er afstemt.",
    "system.controls.error.capabilityUnavailable":
      "Denne styring er ikke tilgængelig: {reason}.",
    "system.controls.accessible.status": "Status for delt brokerstyring.",
    "system.controls.accessible.globalScope":
      "Gælder globalt for styrede anmodninger fra alle projekter.",
    "system.controls.accessible.pending":
      "Venter på en autoritativ kvittering fra broker.",
    "system.controls.accessible.action": "{action} den delte broker.",
    "system.controls.accessible.disabled":
      "{action} er ikke tilgængelig: {reason}.",
  },
  nl: {
    "system.controls.title": "Besturing van de gedeelde broker.",
    "system.controls.scope.project":
      "Dit is globale besturing van de ene gedeelde broker; alle projecten worden beïnvloed, waaronder {projectName}.",
    "system.controls.scope.managedOnly":
      "Pauzeren stopt alleen nieuwe door fmcad beheerde aanvragen. Fusion en andere toepassingen worden niet gestopt.",
    "system.controls.status.label": "Brokerstatus.",
    "system.controls.phase.running": "Accepteert beheerde aanvragen.",
    "system.controls.phase.paused":
      "Gepauzeerd. Nieuwe beheerde aanvragen worden vastgehouden.",
    "system.controls.phase.pausing":
      "Pauzeren; actieve beheerde aanvragen kunnen nog lopen.",
    "system.controls.phase.draining":
      "Bezig met afronden; wacht op {activeOperations} actieve beheerde aanvragen.",
    "system.controls.phase.stopped": "Gestopt.",
    "system.controls.phase.unknown": "De brokerstatus is onbekend.",
    "system.controls.phase.recoveryBlocked":
      "Onopgelost brokerwerk moet worden verzoend; besturing is uitgeschakeld.",
    "system.controls.phase.offline":
      "De broker is offline; de huidige status is niet beschikbaar.",
    "system.controls.action.pause": "Geen aanvragen meer accepteren.",
    "system.controls.action.drain": "Pauzeren en actieve aanvragen afronden.",
    "system.controls.action.resume": "Aanvragen weer accepteren.",
    "system.controls.action.start": "Broker starten.",
    "system.controls.action.refresh": "Brokerstatus vernieuwen.",
    "system.controls.action.reconcile": "Oorspronkelijke aanvraag controleren.",
    "system.controls.action.pending": "Wachten op bevestiging van de broker.",
    "system.controls.action.confirmed": "Broker heeft {phase} bevestigd.",
    "system.controls.action.unknown":
      "Uitkomst onbekend. De oorspronkelijke ontvangstbevestiging wordt gecontroleerd; de actie wordt niet opnieuw verzonden.",
    "system.controls.action.receiptPending":
      "De oorspronkelijke aanvraag is in behandeling. De ontvangstbevestiging wordt gecontroleerd; er wordt geen tweede actie verzonden.",
    "system.controls.safety.noReplay":
      "Herhaal een actie niet zolang de ontvangstbevestiging in behandeling is of de uitkomst onbekend is.",
    "system.controls.error.unauthorized":
      "U bent niet gemachtigd om de gedeelde broker te besturen.",
    "system.controls.error.storageUnavailable":
      "Persistente browseropslag is niet beschikbaar. Besturing is uitgeschakeld om herhaling te voorkomen.",
    "system.controls.error.unsupported":
      "Deze broker ondersteunt {action} niet.",
    "system.controls.error.offline":
      "De broker is offline. Er is geen actie bevestigd.",
    "system.controls.error.generationConflict":
      "De brokerstatus is na het lezen gewijzigd; er is geen actie toegepast.",
    "system.controls.error.instanceChanged":
      "De brokerinstantie is gewijzigd. Vernieuw de status voordat u een actie uitvoert.",
    "system.controls.error.reconciliationRequired":
      "Er is onopgelost werk bij de broker. Hervatten en starten zijn uitgeschakeld totdat dit is verzoend.",
    "system.controls.error.capabilityUnavailable":
      "Deze besturing is niet beschikbaar: {reason}.",
    "system.controls.accessible.status": "Status van gedeelde brokerbesturing.",
    "system.controls.accessible.globalScope":
      "Geldt wereldwijd voor beheerde aanvragen uit alle projecten.",
    "system.controls.accessible.pending":
      "Wachten op een gezaghebbende ontvangstbevestiging van de broker.",
    "system.controls.accessible.action": "{action} de gedeelde broker.",
    "system.controls.accessible.disabled":
      "{action} is niet beschikbaar: {reason}.",
  },
  en: ENGLISH_SYSTEM_CONTROL_CATALOG,
  et: {
    "system.controls.title": "Ühise maakleri juhtimine.",
    "system.controls.scope.project":
      "See on ainsa ühise maakleri globaalne juhtimine; see mõjutab kõiki projekte, sealhulgas projekti {projectName}.",
    "system.controls.scope.managedOnly":
      "Peatamine lõpetab ainult uute fmcad-i hallatavate päringute vastuvõtu. Fusion ega muud rakendused ei peatu.",
    "system.controls.status.label": "Maakleri olek.",
    "system.controls.phase.running": "Võtab hallatavaid päringuid vastu.",
    "system.controls.phase.paused": "Peatatud. Uued hallatavad päringud ootel.",
    "system.controls.phase.pausing":
      "Peatub; aktiivsed hallatavad päringud võivad veel töötada.",
    "system.controls.phase.draining":
      "Tühjendamine; oodatakse {activeOperations} aktiivset hallatavat päringut.",
    "system.controls.phase.stopped": "Peatatud.",
    "system.controls.phase.unknown": "Maakleri olek pole teada.",
    "system.controls.phase.recoveryBlocked":
      "Lahendamata maakleritöö vajab kooskõlastamist; juhtnupud on keelatud.",
    "system.controls.phase.offline":
      "Maakler on võrguühenduseta; praegune olek pole saadaval.",
    "system.controls.action.pause": "Lõpeta päringute vastuvõtt.",
    "system.controls.action.drain": "Peata ja lõpeta aktiivsed päringud.",
    "system.controls.action.resume": "Jätka päringute vastuvõttu.",
    "system.controls.action.start": "Käivita maakler.",
    "system.controls.action.refresh": "Värskenda maakleri olekut.",
    "system.controls.action.reconcile": "Kontrolli algset päringut.",
    "system.controls.action.pending": "Oodatakse maakleri kinnitust.",
    "system.controls.action.confirmed": "Maakler kinnitas: {phase}.",
    "system.controls.action.unknown":
      "Tulemus pole teada. Algset kviitungit kontrollitakse; toimingut uuesti ei saadeta.",
    "system.controls.action.receiptPending":
      "Algne päring on ootel. Kviitungit kontrollitakse; teist toimingut ei saadeta.",
    "system.controls.safety.noReplay":
      "Ära korda toimingut, kui kviitung on ootel või tulemus pole teada.",
    "system.controls.error.unauthorized":
      "Sul pole õigust ühist maaklerit juhtida.",
    "system.controls.error.storageUnavailable":
      "Brauseri püsisalvestusruum pole saadaval. Juhtimine on kordussaatmise vältimiseks keelatud.",
    "system.controls.error.unsupported":
      "See maakler ei toeta toimingut {action}.",
    "system.controls.error.offline":
      "Maakler on võrguühenduseta. Toimingut ei kinnitatud.",
    "system.controls.error.generationConflict":
      "Maakleri olek muutus pärast selle lugemist; toimingut ei rakendatud.",
    "system.controls.error.instanceChanged":
      "Maakleri eksemplar muutus. Värskenda olekut enne toimingu tegemist.",
    "system.controls.error.reconciliationRequired":
      "Maakleril on lahendamata tööd. Jätkamine ja käivitamine on kuni kooskõlastamiseni keelatud.",
    "system.controls.error.capabilityUnavailable":
      "See juhtimine pole saadaval: {reason}.",
    "system.controls.accessible.status": "Ühise maakleri juhtimise olek.",
    "system.controls.accessible.globalScope":
      "Kehtib globaalselt kõigi projektide hallatavatele päringutele.",
    "system.controls.accessible.pending":
      "Oodatakse maakleri autoriteetset kviitungit.",
    "system.controls.accessible.action": "{action} ühist maaklerit.",
    "system.controls.accessible.disabled": "{action} pole saadaval: {reason}.",
  },
  fi: {
    "system.controls.title": "Jaetun välittäjän hallinta.",
    "system.controls.scope.project":
      "Tämä on yhden jaetun välittäjän yleinen hallinta; se vaikuttaa kaikkiin projekteihin, myös projektiin {projectName}.",
    "system.controls.scope.managedOnly":
      "Keskeytys estää vain uudet fmcad-hallittavat pyynnöt. Se ei pysäytä Fusionia eikä muita sovelluksia.",
    "system.controls.status.label": "Välittäjän tila.",
    "system.controls.phase.running": "Ottaa hallittavia pyyntöjä vastaan.",
    "system.controls.phase.paused":
      "Keskeytetty. Uudet hallittavat pyynnöt pidetään odottamassa.",
    "system.controls.phase.pausing":
      "Keskeytetään; aktiiviset hallittavat pyynnöt voivat yhä olla käynnissä.",
    "system.controls.phase.draining":
      "Tyhjennetään; odotetaan {activeOperations} aktiivista hallittavaa pyyntöä.",
    "system.controls.phase.stopped": "Pysäytetty.",
    "system.controls.phase.unknown": "Välittäjän tila on tuntematon.",
    "system.controls.phase.recoveryBlocked":
      "Välittäjällä on selvittämätöntä työtä; ohjaimet on poistettu käytöstä.",
    "system.controls.phase.offline":
      "Välittäjä on offline-tilassa; nykyinen tila ei ole saatavilla.",
    "system.controls.action.pause": "Lopeta pyyntöjen vastaanotto.",
    "system.controls.action.drain":
      "Keskeytä ja viimeistele aktiiviset pyynnöt.",
    "system.controls.action.resume": "Jatka pyyntöjen vastaanottoa.",
    "system.controls.action.start": "Käynnistä välittäjä.",
    "system.controls.action.refresh": "Päivitä välittäjän tila.",
    "system.controls.action.reconcile": "Tarkista alkuperäinen pyyntö.",
    "system.controls.action.pending": "Odotetaan välittäjän vahvistusta.",
    "system.controls.action.confirmed": "Välittäjä vahvisti: {phase}.",
    "system.controls.action.unknown":
      "Tulos on tuntematon. Alkuperäistä kuittausta tarkistetaan; toimintoa ei lähetetä uudelleen.",
    "system.controls.action.receiptPending":
      "Alkuperäinen pyyntö on kesken. Sen kuittausta tarkistetaan; toista toimintoa ei lähetetä.",
    "system.controls.safety.noReplay":
      "Älä toista toimintoa, kun sen kuittaus on kesken tai tulos on tuntematon.",
    "system.controls.error.unauthorized":
      "Sinulla ei ole oikeutta hallita jaettua välittäjää.",
    "system.controls.error.storageUnavailable":
      "Selaimen pysyvä tallennustila ei ole käytettävissä. Ohjaimet on poistettu käytöstä uudelleenlähetyksen estämiseksi.",
    "system.controls.error.unsupported":
      "Tämä välittäjä ei tue toimintoa {action}.",
    "system.controls.error.offline":
      "Välittäjä on offline-tilassa. Toimintoa ei vahvistettu.",
    "system.controls.error.generationConflict":
      "Välittäjän tila muuttui lukemisen jälkeen; toimintoa ei suoritettu.",
    "system.controls.error.instanceChanged":
      "Välittäjän esiintymä muuttui. Päivitä tila ennen toimintaa.",
    "system.controls.error.reconciliationRequired":
      "Välittäjällä on selvittämätöntä työtä. Jatkaminen ja käynnistys eivät ole käytettävissä ennen selvitystä.",
    "system.controls.error.capabilityUnavailable":
      "Tämä ohjaus ei ole käytettävissä: {reason}.",
    "system.controls.accessible.status": "Jaetun välittäjän hallinnan tila.",
    "system.controls.accessible.globalScope":
      "Koskee yleisesti kaikkien projektien hallittavia pyyntöjä.",
    "system.controls.accessible.pending":
      "Odotetaan välittäjän virallista kuittausta.",
    "system.controls.accessible.action": "{action} jaettua välittäjää.",
    "system.controls.accessible.disabled":
      "Toiminto {action} ei ole käytettävissä: {reason}.",
  },
  fr: {
    "system.controls.title": "Contrôle partagé du courtier.",
    "system.controls.scope.project":
      "Ce contrôle global agit sur l’unique courtier partagé et concerne tous les projets, y compris {projectName}.",
    "system.controls.scope.managedOnly":
      "La mise en pause arrête uniquement les nouvelles requêtes gérées par fmcad. Elle n’arrête ni Fusion ni les autres applications.",
    "system.controls.status.label": "État du courtier.",
    "system.controls.phase.running": "Accepte les requêtes gérées.",
    "system.controls.phase.paused":
      "En pause. Les nouvelles requêtes gérées sont retenues.",
    "system.controls.phase.pausing":
      "Mise en pause ; des requêtes gérées actives peuvent encore s’exécuter.",
    "system.controls.phase.draining":
      "Vidage en cours ; attente de {activeOperations} requêtes gérées actives.",
    "system.controls.phase.stopped": "Arrêté.",
    "system.controls.phase.unknown": "L’état du courtier est inconnu.",
    "system.controls.phase.recoveryBlocked":
      "Des opérations non résolues du courtier doivent être rapprochées ; les commandes sont désactivées.",
    "system.controls.phase.offline":
      "Le courtier est hors ligne ; son état actuel est indisponible.",
    "system.controls.action.pause": "Cesser d’accepter les requêtes.",
    "system.controls.action.drain":
      "Mettre en pause et terminer les requêtes actives.",
    "system.controls.action.resume": "Reprendre l’acceptation des requêtes.",
    "system.controls.action.start": "Démarrer le courtier.",
    "system.controls.action.refresh": "Actualiser l’état du courtier.",
    "system.controls.action.reconcile": "Vérifier la requête d’origine.",
    "system.controls.action.pending": "En attente de confirmation du courtier.",
    "system.controls.action.confirmed": "Le courtier a confirmé : {phase}.",
    "system.controls.action.unknown":
      "Résultat inconnu. Vérification du reçu d’origine ; l’action ne sera pas renvoyée.",
    "system.controls.action.receiptPending":
      "La requête d’origine est en attente. Vérification de son reçu ; aucune seconde action ne sera envoyée.",
    "system.controls.safety.noReplay":
      "Ne répétez pas une action tant que son reçu est en attente ou que le résultat est inconnu.",
    "system.controls.error.unauthorized":
      "Vous n’êtes pas autorisé à contrôler le courtier partagé.",
    "system.controls.error.storageUnavailable":
      "Le stockage persistant du navigateur est indisponible. Les commandes sont désactivées pour éviter toute répétition.",
    "system.controls.error.unsupported":
      "Ce courtier ne prend pas en charge {action}.",
    "system.controls.error.offline":
      "Le courtier est hors ligne. Aucune action n’a été confirmée.",
    "system.controls.error.generationConflict":
      "L’état du courtier a changé après sa lecture ; aucune action n’a été appliquée.",
    "system.controls.error.instanceChanged":
      "L’instance du courtier a changé. Actualisez l’état avant d’agir.",
    "system.controls.error.reconciliationRequired":
      "Le courtier a des opérations non résolues. Reprendre et démarrer sont désactivés jusqu’à leur rapprochement.",
    "system.controls.error.capabilityUnavailable":
      "Cette commande est indisponible : {reason}.",
    "system.controls.accessible.status":
      "État du contrôle partagé du courtier.",
    "system.controls.accessible.globalScope":
      "S’applique globalement aux requêtes gérées de tous les projets.",
    "system.controls.accessible.pending":
      "En attente du reçu faisant autorité du courtier.",
    "system.controls.accessible.action": "{action} le courtier partagé.",
    "system.controls.accessible.disabled": "{action} indisponible : {reason}.",
  },
  de: {
    "system.controls.title": "Steuerung des gemeinsamen Brokers.",
    "system.controls.scope.project":
      "Dies ist die globale Steuerung des einen gemeinsamen Brokers; sie betrifft alle Projekte einschließlich {projectName}.",
    "system.controls.scope.managedOnly":
      "Pausieren stoppt nur neue von fmcad verwaltete Anfragen. Fusion und andere Anwendungen werden nicht angehalten.",
    "system.controls.status.label": "Brokerstatus.",
    "system.controls.phase.running": "Nimmt verwaltete Anfragen an.",
    "system.controls.phase.paused":
      "Pausiert. Neue verwaltete Anfragen werden zurückgehalten.",
    "system.controls.phase.pausing":
      "Wird pausiert; aktive verwaltete Anfragen können noch laufen.",
    "system.controls.phase.draining":
      "Wird abgearbeitet; wartet auf {activeOperations} aktive verwaltete Anfragen.",
    "system.controls.phase.stopped": "Gestoppt.",
    "system.controls.phase.unknown": "Der Brokerstatus ist unbekannt.",
    "system.controls.phase.recoveryBlocked":
      "Ungeklärte Brokerarbeit muss abgeglichen werden; die Steuerung ist deaktiviert.",
    "system.controls.phase.offline":
      "Der Broker ist offline; der aktuelle Status ist nicht verfügbar.",
    "system.controls.action.pause": "Keine Anfragen mehr annehmen.",
    "system.controls.action.drain": "Pausieren und aktive Anfragen abarbeiten.",
    "system.controls.action.resume": "Annahme von Anfragen fortsetzen.",
    "system.controls.action.start": "Broker starten.",
    "system.controls.action.refresh": "Brokerstatus aktualisieren.",
    "system.controls.action.reconcile": "Ursprüngliche Anfrage prüfen.",
    "system.controls.action.pending": "Warten auf Brokerbestätigung.",
    "system.controls.action.confirmed": "Broker hat {phase} bestätigt.",
    "system.controls.action.unknown":
      "Ausgang unbekannt. Der ursprüngliche Beleg wird geprüft; die Aktion wird nicht erneut gesendet.",
    "system.controls.action.receiptPending":
      "Die ursprüngliche Anfrage ist noch offen. Ihr Beleg wird geprüft; es wird keine zweite Aktion gesendet.",
    "system.controls.safety.noReplay":
      "Wiederholen Sie eine Aktion nicht, solange ihr Beleg offen oder der Ausgang unbekannt ist.",
    "system.controls.error.unauthorized":
      "Sie sind nicht berechtigt, den gemeinsamen Broker zu steuern.",
    "system.controls.error.storageUnavailable":
      "Der dauerhafte Browserspeicher ist nicht verfügbar. Die Steuerung ist deaktiviert, um eine Wiederholung zu verhindern.",
    "system.controls.error.unsupported":
      "Dieser Broker unterstützt {action} nicht.",
    "system.controls.error.offline":
      "Der Broker ist offline. Es wurde keine Aktion bestätigt.",
    "system.controls.error.generationConflict":
      "Der Brokerstatus hat sich nach dem Lesen geändert; es wurde keine Aktion ausgeführt.",
    "system.controls.error.instanceChanged":
      "Die Brokerinstanz hat sich geändert. Aktualisieren Sie den Status, bevor Sie handeln.",
    "system.controls.error.reconciliationRequired":
      "Der Broker hat ungeklärte Arbeit. Fortsetzen und Starten sind bis zum Abgleich deaktiviert.",
    "system.controls.error.capabilityUnavailable":
      "Diese Steuerung ist nicht verfügbar: {reason}.",
    "system.controls.accessible.status":
      "Status der gemeinsamen Brokersteuerung.",
    "system.controls.accessible.globalScope":
      "Gilt global für verwaltete Anfragen aus allen Projekten.",
    "system.controls.accessible.pending":
      "Warten auf den maßgeblichen Brokerbeleg.",
    "system.controls.accessible.action": "Gemeinsamen Broker {action}.",
    "system.controls.accessible.disabled":
      "{action} nicht verfügbar: {reason}.",
  },
  el: {
    "system.controls.title": "Κοινός έλεγχος μεσολαβητή.",
    "system.controls.scope.project":
      "Αυτός είναι ο καθολικός έλεγχος του μοναδικού κοινού μεσολαβητή· επηρεάζει όλα τα έργα, συμπεριλαμβανομένου του {projectName}.",
    "system.controls.scope.managedOnly":
      "Η παύση σταματά μόνο τα νέα αιτήματα που διαχειρίζεται το fmcad. Δεν σταματά το Fusion ή άλλες εφαρμογές.",
    "system.controls.status.label": "Κατάσταση μεσολαβητή.",
    "system.controls.phase.running": "Δέχεται διαχειριζόμενα αιτήματα.",
    "system.controls.phase.paused":
      "Σε παύση. Τα νέα διαχειριζόμενα αιτήματα αναστέλλονται.",
    "system.controls.phase.pausing":
      "Γίνεται παύση· ενεργά διαχειριζόμενα αιτήματα μπορεί να συνεχίζουν να εκτελούνται.",
    "system.controls.phase.draining":
      "Ολοκλήρωση ενεργειών· αναμονή για {activeOperations} ενεργά διαχειριζόμενα αιτήματα.",
    "system.controls.phase.stopped": "Διακόπηκε.",
    "system.controls.phase.unknown":
      "Η κατάσταση του μεσολαβητή είναι άγνωστη.",
    "system.controls.phase.recoveryBlocked":
      "Εκκρεμείς εργασίες του μεσολαβητή απαιτούν συμφωνία· τα στοιχεία ελέγχου είναι απενεργοποιημένα.",
    "system.controls.phase.offline":
      "Ο μεσολαβητής είναι εκτός σύνδεσης· η τρέχουσα κατάσταση δεν είναι διαθέσιμη.",
    "system.controls.action.pause": "Διακοπή αποδοχής αιτημάτων.",
    "system.controls.action.drain": "Παύση και ολοκλήρωση ενεργών αιτημάτων.",
    "system.controls.action.resume": "Συνέχιση αποδοχής αιτημάτων.",
    "system.controls.action.start": "Εκκίνηση μεσολαβητή.",
    "system.controls.action.refresh": "Ανανέωση κατάστασης μεσολαβητή.",
    "system.controls.action.reconcile": "Έλεγχος αρχικού αιτήματος.",
    "system.controls.action.pending":
      "Αναμονή επιβεβαίωσης από τον μεσολαβητή.",
    "system.controls.action.confirmed": "Ο μεσολαβητής επιβεβαίωσε: {phase}.",
    "system.controls.action.unknown":
      "Άγνωστο αποτέλεσμα. Ελέγχεται η αρχική απόδειξη· η ενέργεια δεν θα σταλεί ξανά.",
    "system.controls.action.receiptPending":
      "Το αρχικό αίτημα εκκρεμεί. Ελέγχεται η απόδειξή του· δεν θα σταλεί δεύτερη ενέργεια.",
    "system.controls.safety.noReplay":
      "Μην επαναλάβετε ενέργεια όσο εκκρεμεί η απόδειξή της ή το αποτέλεσμα είναι άγνωστο.",
    "system.controls.error.unauthorized":
      "Δεν έχετε εξουσιοδότηση για τον έλεγχο του κοινού μεσολαβητή.",
    "system.controls.error.storageUnavailable":
      "Ο μόνιμος χώρος αποθήκευσης του προγράμματος περιήγησης δεν είναι διαθέσιμος. Τα στοιχεία ελέγχου απενεργοποιούνται για να αποτραπεί η επανάληψη.",
    "system.controls.error.unsupported":
      "Αυτός ο μεσολαβητής δεν υποστηρίζει την ενέργεια {action}.",
    "system.controls.error.offline":
      "Ο μεσολαβητής είναι εκτός σύνδεσης. Δεν επιβεβαιώθηκε καμία ενέργεια.",
    "system.controls.error.generationConflict":
      "Η κατάσταση του μεσολαβητή άλλαξε μετά την ανάγνωση· δεν εφαρμόστηκε καμία ενέργεια.",
    "system.controls.error.instanceChanged":
      "Η παρουσία του μεσολαβητή άλλαξε. Ανανεώστε την κατάσταση πριν ενεργήσετε.",
    "system.controls.error.reconciliationRequired":
      "Ο μεσολαβητής έχει εκκρεμείς εργασίες. Η συνέχιση και η εκκίνηση είναι απενεργοποιημένες μέχρι τη συμφωνία τους.",
    "system.controls.error.capabilityUnavailable":
      "Αυτός ο έλεγχος δεν είναι διαθέσιμος: {reason}.",
    "system.controls.accessible.status": "Κατάσταση κοινού ελέγχου μεσολαβητή.",
    "system.controls.accessible.globalScope":
      "Ισχύει καθολικά για διαχειριζόμενα αιτήματα από όλα τα έργα.",
    "system.controls.accessible.pending":
      "Αναμονή έγκυρης απόδειξης από τον μεσολαβητή.",
    "system.controls.accessible.action": "{action} τον κοινό μεσολαβητή.",
    "system.controls.accessible.disabled":
      "Η ενέργεια {action} δεν είναι διαθέσιμη: {reason}.",
  },
  hu: {
    "system.controls.title": "Megosztott broker vezérlése.",
    "system.controls.scope.project":
      "Ez az egyetlen megosztott broker globális vezérlése; minden projektet érint, beleértve ezt is: {projectName}.",
    "system.controls.scope.managedOnly":
      "A szüneteltetés csak az új, fmcad által kezelt kéréseket állítja meg. A Fusiont és más alkalmazásokat nem állítja le.",
    "system.controls.status.label": "Broker állapota.",
    "system.controls.phase.running": "Fogadja a kezelt kéréseket.",
    "system.controls.phase.paused":
      "Szüneteltetve. Az új kezelt kérések várakoznak.",
    "system.controls.phase.pausing":
      "Szüneteltetés folyamatban; az aktív kezelt kérések még futhatnak.",
    "system.controls.phase.draining":
      "Leürítés folyamatban; {activeOperations} aktív kezelt kérés befejezésére vár.",
    "system.controls.phase.stopped": "Leállítva.",
    "system.controls.phase.unknown": "A broker állapota ismeretlen.",
    "system.controls.phase.recoveryBlocked":
      "A megoldatlan brokerfeladatot egyeztetni kell; a vezérlők le vannak tiltva.",
    "system.controls.phase.offline":
      "A broker offline; az aktuális állapot nem érhető el.",
    "system.controls.action.pause": "Kérések fogadásának leállítása.",
    "system.controls.action.drain":
      "Szüneteltetés és az aktív kérések befejezése.",
    "system.controls.action.resume": "Kérések fogadásának folytatása.",
    "system.controls.action.start": "Broker indítása.",
    "system.controls.action.refresh": "Broker állapotának frissítése.",
    "system.controls.action.reconcile": "Eredeti kérés ellenőrzése.",
    "system.controls.action.pending": "Várakozás a broker megerősítésére.",
    "system.controls.action.confirmed": "A broker megerősítette: {phase}.",
    "system.controls.action.unknown":
      "Az eredmény ismeretlen. Az eredeti nyugta ellenőrzése folyamatban; a művelet nem lesz újra elküldve.",
    "system.controls.action.receiptPending":
      "Az eredeti kérés függőben van. A nyugtáját ellenőrizzük; második művelet nem lesz elküldve.",
    "system.controls.safety.noReplay":
      "Ne ismételje meg a műveletet, amíg a nyugtája függőben van vagy az eredménye ismeretlen.",
    "system.controls.error.unauthorized":
      "Nincs jogosultsága a megosztott broker vezérléséhez.",
    "system.controls.error.storageUnavailable":
      "A böngésző tartós tárolója nem érhető el. A vezérlés az ismétlés megelőzése érdekében le van tiltva.",
    "system.controls.error.unsupported":
      "Ezt a műveletet ({action}) ez a broker nem támogatja.",
    "system.controls.error.offline":
      "A broker offline. Műveletet nem erősített meg.",
    "system.controls.error.generationConflict":
      "A broker állapota az olvasás után megváltozott; a művelet nem történt meg.",
    "system.controls.error.instanceChanged":
      "A brokerpéldány megváltozott. Művelet előtt frissítse az állapotot.",
    "system.controls.error.reconciliationRequired":
      "A brokerben megoldatlan munka van. A folytatás és az indítás az egyeztetésig le van tiltva.",
    "system.controls.error.capabilityUnavailable":
      "Ez a vezérlő nem érhető el: {reason}.",
    "system.controls.accessible.status":
      "A megosztott broker vezérlési állapota.",
    "system.controls.accessible.globalScope":
      "Globálisan vonatkozik minden projekt kezelt kéréseire.",
    "system.controls.accessible.pending":
      "Várakozás a broker hiteles nyugtájára.",
    "system.controls.accessible.action": "A megosztott broker {action}.",
    "system.controls.accessible.disabled":
      "A(z) {action} nem érhető el: {reason}.",
  },
  ga: {
    "system.controls.title": "Rialú ar an mbróicéir comhroinnte.",
    "system.controls.scope.project":
      "Rialú domhanda é seo ar an aon bhróicéir comhroinnte; bíonn tionchar aige ar gach tionscadal, lena n-áirítear {projectName}.",
    "system.controls.scope.managedOnly":
      "Ní stopann an tsos ach iarratais nua atá á mbainistiú ag fmcad. Ní stopann sé Fusion ná feidhmchláir eile.",
    "system.controls.status.label": "Stádas an bhróicéara.",
    "system.controls.phase.running": "Glacann sé le hiarratais bhainistithe.",
    "system.controls.phase.paused":
      "Ar sos. Coinnítear iarratais bhainistithe nua siar.",
    "system.controls.phase.pausing":
      "Á chur ar sos; seans go bhfuil iarratais bhainistithe ghníomhacha fós ar siúl.",
    "system.controls.phase.draining":
      "Á bhánú; ag fanacht ar {activeOperations} iarratas bainistithe gníomhach.",
    "system.controls.phase.stopped": "Stoptha.",
    "system.controls.phase.unknown": "Ní fios staid an bhróicéara.",
    "system.controls.phase.recoveryBlocked":
      "Ní mór obair gan réiteach an bhróicéara a réiteach; tá na rialuithe díchumasaithe.",
    "system.controls.phase.offline":
      "Tá an bróicéir as líne; níl an staid reatha ar fáil.",
    "system.controls.action.pause": "Stop le glacadh le hiarratais.",
    "system.controls.action.drain":
      "Cuir ar sos agus críochnaigh iarratais ghníomhacha.",
    "system.controls.action.resume": "Lean le glacadh le hiarratais.",
    "system.controls.action.start": "Tosaigh an bróicéir.",
    "system.controls.action.refresh": "Athnuaigh stádas an bhróicéara.",
    "system.controls.action.reconcile": "Seiceáil an t-iarratas bunaidh.",
    "system.controls.action.pending": "Ag fanacht le deimhniú ón mbróicéir.",
    "system.controls.action.confirmed": "Dheimhnigh an bróicéir: {phase}.",
    "system.controls.action.unknown":
      "Toradh anaithnid. Tá an admháil bhunaidh á seiceáil; ní sheolfar an gníomh arís.",
    "system.controls.action.receiptPending":
      "Tá an t-iarratas bunaidh ar feitheamh. Tá a admháil á seiceáil; ní sheolfar dara gníomh.",
    "system.controls.safety.noReplay":
      "Ná déan gníomh arís fad atá a admháil ar feitheamh nó an toradh anaithnid.",
    "system.controls.error.unauthorized":
      "Níl cead agat an bróicéir comhroinnte a rialú.",
    "system.controls.error.storageUnavailable":
      "Níl stóras buan an bhrabhsálaí ar fáil. Tá na rialuithe díchumasaithe chun athsheoladh a chosc.",
    "system.controls.error.unsupported":
      "Ní thacaíonn an bróicéir seo le {action}.",
    "system.controls.error.offline":
      "Tá an bróicéir as líne. Níor deimhníodh aon ghníomh.",
    "system.controls.error.generationConflict":
      "D'athraigh staid an bhróicéara tar éis í a léamh; níor cuireadh aon ghníomh i bhfeidhm.",
    "system.controls.error.instanceChanged":
      "D'athraigh sampla an bhróicéara. Athnuaigh an stádas sula ndéanann tú gníomh.",
    "system.controls.error.reconciliationRequired":
      "Tá obair gan réiteach ag an mbróicéir. Tá atosú agus tús díchumasaithe go dtí go réitítear í.",
    "system.controls.error.capabilityUnavailable":
      "Níl an rialú seo ar fáil: {reason}.",
    "system.controls.accessible.status":
      "Stádas rialaithe an bhróicéara chomhroinnte.",
    "system.controls.accessible.globalScope":
      "Baineann sé go domhanda le hiarratais bhainistithe ó gach tionscadal.",
    "system.controls.accessible.pending":
      "Ag fanacht ar admháil údarásach ón mbróicéir.",
    "system.controls.accessible.action": "{action} an bróicéir comhroinnte.",
    "system.controls.accessible.disabled": "Níl {action} ar fáil: {reason}.",
  },
  it: {
    "system.controls.title": "Controllo del broker condiviso.",
    "system.controls.scope.project":
      "Questo è il controllo globale dell'unico broker condiviso; riguarda tutti i progetti, incluso {projectName}.",
    "system.controls.scope.managedOnly":
      "La pausa blocca solo le nuove richieste gestite da fmcad. Non arresta Fusion né altre applicazioni.",
    "system.controls.status.label": "Stato del broker.",
    "system.controls.phase.running": "Accetta richieste gestite.",
    "system.controls.phase.paused":
      "In pausa. Le nuove richieste gestite sono trattenute.",
    "system.controls.phase.pausing":
      "Pausa in corso; le richieste gestite attive potrebbero essere ancora in esecuzione.",
    "system.controls.phase.draining":
      "Completamento in corso; in attesa di {activeOperations} richieste gestite attive.",
    "system.controls.phase.stopped": "Arrestato.",
    "system.controls.phase.unknown": "Lo stato del broker è sconosciuto.",
    "system.controls.phase.recoveryBlocked":
      "Le attività irrisolte del broker richiedono una riconciliazione; i controlli sono disattivati.",
    "system.controls.phase.offline":
      "Il broker è offline; lo stato attuale non è disponibile.",
    "system.controls.action.pause": "Smetti di accettare richieste.",
    "system.controls.action.drain":
      "Metti in pausa e completa le richieste attive.",
    "system.controls.action.resume": "Riprendi ad accettare richieste.",
    "system.controls.action.start": "Avvia il broker.",
    "system.controls.action.refresh": "Aggiorna lo stato del broker.",
    "system.controls.action.reconcile": "Controlla la richiesta originale.",
    "system.controls.action.pending": "In attesa della conferma del broker.",
    "system.controls.action.confirmed": "Il broker ha confermato: {phase}.",
    "system.controls.action.unknown":
      "Esito sconosciuto. Controllo della ricevuta originale; l'azione non verrà inviata di nuovo.",
    "system.controls.action.receiptPending":
      "La richiesta originale è in sospeso. Controllo della ricevuta; non verrà inviata una seconda azione.",
    "system.controls.safety.noReplay":
      "Non ripetere un'azione mentre la ricevuta è in sospeso o l'esito è sconosciuto.",
    "system.controls.error.unauthorized":
      "Non sei autorizzato a controllare il broker condiviso.",
    "system.controls.error.storageUnavailable":
      "L'archiviazione persistente del browser non è disponibile. I controlli sono disattivati per evitare la ripetizione dell'azione.",
    "system.controls.error.unsupported": "Questo broker non supporta {action}.",
    "system.controls.error.offline":
      "Il broker è offline. Nessuna azione è stata confermata.",
    "system.controls.error.generationConflict":
      "Lo stato del broker è cambiato dopo la lettura; non è stata applicata alcuna azione.",
    "system.controls.error.instanceChanged":
      "L'istanza del broker è cambiata. Aggiorna lo stato prima di agire.",
    "system.controls.error.reconciliationRequired":
      "Il broker ha attività irrisolte. Ripresa e avvio sono disattivati finché non vengono riconciliate.",
    "system.controls.error.capabilityUnavailable":
      "Questo controllo non è disponibile: {reason}.",
    "system.controls.accessible.status":
      "Stato del controllo del broker condiviso.",
    "system.controls.accessible.globalScope":
      "Si applica globalmente alle richieste gestite di tutti i progetti.",
    "system.controls.accessible.pending":
      "In attesa della ricevuta autorevole del broker.",
    "system.controls.accessible.action": "{action} il broker condiviso.",
    "system.controls.accessible.disabled":
      "{action} non disponibile: {reason}.",
  },
  lv: {
    "system.controls.title": "Koplietojamā brokera vadība.",
    "system.controls.scope.project":
      "Šī ir vienīgā koplietojamā brokera globālā vadība; tā ietekmē visus projektus, tostarp {projectName}.",
    "system.controls.scope.managedOnly":
      "Pauzēšana aptur tikai jaunus fmcad pārvaldītus pieprasījumus. Tā neaptur Fusion vai citas lietotnes.",
    "system.controls.status.label": "Bro­kera statuss.",
    "system.controls.phase.running": "Pieņem pārvaldītus pieprasījumus.",
    "system.controls.phase.paused":
      "Pauzēts. Jauni pārvaldītie pieprasījumi tiek aizturēti.",
    "system.controls.phase.pausing":
      "Notiek pauzēšana; aktīvie pārvaldītie pieprasījumi vēl var darboties.",
    "system.controls.phase.draining":
      "Notiek pabeigšana; tiek gaidīti {activeOperations} aktīvi pārvaldīti pieprasījumi.",
    "system.controls.phase.stopped": "Apturēts.",
    "system.controls.phase.unknown": "Brokera stāvoklis nav zināms.",
    "system.controls.phase.recoveryBlocked":
      "Neatrisinātam brokera darbam nepieciešama saskaņošana; vadīklas ir atspējotas.",
    "system.controls.phase.offline":
      "Brokeris ir bezsaistē; pašreizējais stāvoklis nav pieejams.",
    "system.controls.action.pause": "Pārtraukt pieprasījumu pieņemšanu.",
    "system.controls.action.drain": "Pauzēt un pabeigt aktīvos pieprasījumus.",
    "system.controls.action.resume": "Atsākt pieprasījumu pieņemšanu.",
    "system.controls.action.start": "Palaist brokeri.",
    "system.controls.action.refresh": "Atsvaidzināt brokera statusu.",
    "system.controls.action.reconcile": "Pārbaudīt sākotnējo pieprasījumu.",
    "system.controls.action.pending": "Tiek gaidīts brokera apstiprinājums.",
    "system.controls.action.confirmed": "Brokeris apstiprināja: {phase}.",
    "system.controls.action.unknown":
      "Rezultāts nav zināms. Tiek pārbaudīts sākotnējais apliecinājums; darbība netiks nosūtīta atkārtoti.",
    "system.controls.action.receiptPending":
      "Sākotnējais pieprasījums gaida izpildi. Tiek pārbaudīts tā apliecinājums; otra darbība netiks nosūtīta.",
    "system.controls.safety.noReplay":
      "Neatkārtojiet darbību, kamēr tās apliecinājums gaida vai rezultāts nav zināms.",
    "system.controls.error.unauthorized":
      "Jums nav atļauts vadīt koplietojamo brokeri.",
    "system.controls.error.storageUnavailable":
      "Pārlūkprogrammas pastāvīgā krātuve nav pieejama. Vadīklas ir atspējotas, lai novērstu darbības atkārtošanu.",
    "system.controls.error.unsupported":
      "Šis brokeris neatbalsta darbību {action}.",
    "system.controls.error.offline":
      "Brokeris ir bezsaistē. Neviena darbība nav apstiprināta.",
    "system.controls.error.generationConflict":
      "Pēc nolasīšanas brokera stāvoklis mainījās; darbība netika veikta.",
    "system.controls.error.instanceChanged":
      "Brokera instance mainījās. Pirms darbības atsvaidziniet statusu.",
    "system.controls.error.reconciliationRequired":
      "Brokerim ir neatrisināts darbs. Atsākšana un palaišana ir atspējota līdz tā saskaņošanai.",
    "system.controls.error.capabilityUnavailable":
      "Šī vadība nav pieejama: {reason}.",
    "system.controls.accessible.status":
      "Koplietojamā brokera vadības statuss.",
    "system.controls.accessible.globalScope":
      "Globāli attiecas uz visu projektu pārvaldītajiem pieprasījumiem.",
    "system.controls.accessible.pending":
      "Tiek gaidīts autoritatīvs brokera apliecinājums.",
    "system.controls.accessible.action": "{action} koplietojamo brokeri.",
    "system.controls.accessible.disabled": "{action} nav pieejama: {reason}.",
  },
  lt: {
    "system.controls.title": "Bendro tarpininko valdymas.",
    "system.controls.scope.project":
      "Tai visuotinis vienintelio bendro tarpininko valdymas; jis veikia visus projektus, įskaitant {projectName}.",
    "system.controls.scope.managedOnly":
      "Pristabdymas sustabdo tik naujas fmcad valdomas užklausas. Jis nesustabdo Fusion ar kitų programų.",
    "system.controls.status.label": "Tarpininko būsena.",
    "system.controls.phase.running": "Priima valdomas užklausas.",
    "system.controls.phase.paused":
      "Pristabdyta. Naujos valdomos užklausos sulaikomos.",
    "system.controls.phase.pausing":
      "Pristabdoma; aktyvios valdomos užklausos vis dar gali būti vykdomos.",
    "system.controls.phase.draining":
      "Baigiama vykdyti; laukiama {activeOperations} aktyvių valdomų užklausų.",
    "system.controls.phase.stopped": "Sustabdyta.",
    "system.controls.phase.unknown": "Tarpininko būsena nežinoma.",
    "system.controls.phase.recoveryBlocked":
      "Neišspręstą tarpininko darbą reikia suderinti; valdikliai išjungti.",
    "system.controls.phase.offline":
      "Tarpininkas neprisijungęs; dabartinė būsena nepasiekiama.",
    "system.controls.action.pause": "Nustoti priimti užklausas.",
    "system.controls.action.drain":
      "Pristabdyti ir užbaigti aktyvias užklausas.",
    "system.controls.action.resume": "Vėl priimti užklausas.",
    "system.controls.action.start": "Paleisti tarpininką.",
    "system.controls.action.refresh": "Atnaujinti tarpininko būseną.",
    "system.controls.action.reconcile": "Patikrinti pradinę užklausą.",
    "system.controls.action.pending": "Laukiama tarpininko patvirtinimo.",
    "system.controls.action.confirmed": "Tarpininkas patvirtino: {phase}.",
    "system.controls.action.unknown":
      "Rezultatas nežinomas. Tikrinamas pradinis kvitas; veiksmas nebus siunčiamas dar kartą.",
    "system.controls.action.receiptPending":
      "Pradinė užklausa dar vykdoma. Tikrinamas jos kvitas; antras veiksmas nebus siunčiamas.",
    "system.controls.safety.noReplay":
      "Nekartokite veiksmo, kol jo kvitas laukia arba rezultatas nežinomas.",
    "system.controls.error.unauthorized":
      "Neturite teisės valdyti bendro tarpininko.",
    "system.controls.error.storageUnavailable":
      "Naršyklės nuolatinė saugykla nepasiekiama. Valdikliai išjungti, kad veiksmas nebūtų pakartotas.",
    "system.controls.error.unsupported":
      "Šis tarpininkas nepalaiko veiksmo {action}.",
    "system.controls.error.offline":
      "Tarpininkas neprisijungęs. Joks veiksmas nepatvirtintas.",
    "system.controls.error.generationConflict":
      "Perskaičius tarpininko būsena pasikeitė; veiksmas nepritaikytas.",
    "system.controls.error.instanceChanged":
      "Tarpininko egzempliorius pasikeitė. Prieš veikdami atnaujinkite būseną.",
    "system.controls.error.reconciliationRequired":
      "Tarpininkas turi neišspręstų darbų. Tęsti ir paleisti negalima, kol jie nesuderinti.",
    "system.controls.error.capabilityUnavailable":
      "Šis valdymas nepasiekiamas: {reason}.",
    "system.controls.accessible.status": "Bendro tarpininko valdymo būsena.",
    "system.controls.accessible.globalScope":
      "Visuotinai taikoma visų projektų valdomoms užklausoms.",
    "system.controls.accessible.pending":
      "Laukiama autoritetingo tarpininko kvito.",
    "system.controls.accessible.action": "{action} bendrą tarpininką.",
    "system.controls.accessible.disabled": "{action} nepasiekiamas: {reason}.",
  },
  mt: {
    "system.controls.title": "Kontroll tal-broker kondiviż.",
    "system.controls.scope.project":
      "Dan huwa kontroll globali tal-uniku broker kondiviż; jaffettwa l-proġetti kollha, inkluż {projectName}.",
    "system.controls.scope.managedOnly":
      "Il-waqfien temporanju jwaqqaf biss talbiet ġodda ġestiti minn fmcad. Ma jwaqqafx Fusion jew applikazzjonijiet oħra.",
    "system.controls.status.label": "L-istat tal-broker.",
    "system.controls.phase.running": "Qed jaċċetta talbiet ġestiti.",
    "system.controls.phase.paused":
      "Imwaqqaf temporanjament. Talbiet ġodda jinżammu.",
    "system.controls.phase.pausing":
      "Qed jitwaqqaf temporanjament; it-talbiet ġestiti attivi jistgħu jkunu għadhom għaddejjin.",
    "system.controls.phase.draining":
      "Qed jitlesta x-xogħol; qed jistenna {activeOperations} talba ġestita attiva.",
    "system.controls.phase.stopped": "Imwaqqaf.",
    "system.controls.phase.unknown": "L-istat tal-broker mhuwiex magħruf.",
    "system.controls.phase.recoveryBlocked":
      "Ix-xogħol mhux solvut tal-broker jeħtieġ rikonċiljazzjoni; il-kontrolli huma diżattivati.",
    "system.controls.phase.offline":
      "Il-broker mhuwiex online; l-istat attwali mhuwiex disponibbli.",
    "system.controls.action.pause": "Waqqaf l-aċċettazzjoni tat-talbiet.",
    "system.controls.action.drain":
      "Waqqaf temporanjament u temm it-talbiet attivi.",
    "system.controls.action.resume": "Kompli bl-aċċettazzjoni tat-talbiet.",
    "system.controls.action.start": "Ibda l-broker.",
    "system.controls.action.refresh": "Aġġorna l-istat tal-broker.",
    "system.controls.action.reconcile": "Iċċekkja t-talba oriġinali.",
    "system.controls.action.pending": "Qed jistenna konferma mill-broker.",
    "system.controls.action.confirmed": "Il-broker ikkonferma: {phase}.",
    "system.controls.action.unknown":
      "Ir-riżultat mhuwiex magħruf. Qed jiġi ċċekkjat l-irċevuta oriġinali; l-azzjoni mhux se tintbagħat mill-ġdid.",
    "system.controls.action.receiptPending":
      "It-talba oriġinali għadha pendenti. Qed jiġi ċċekkjat l-irċevuta tagħha; ma tintbagħatx it-tieni azzjoni.",
    "system.controls.safety.noReplay":
      "Terġax tagħmel azzjoni waqt li l-irċevuta tagħha tkun pendenti jew ir-riżultat mhux magħruf.",
    "system.controls.error.unauthorized":
      "M'għandekx awtorizzazzjoni biex tikkontrolla l-broker kondiviż.",
    "system.controls.error.storageUnavailable":
      "Il-ħażna persistenti tal-browser mhijiex disponibbli. Il-kontrolli huma diżattivati biex tiġi evitata ripetizzjoni tal-azzjoni.",
    "system.controls.error.unsupported":
      "Dan il-broker ma jappoġġjax {action}.",
    "system.controls.error.offline":
      "Il-broker mhuwiex online. Ma ġiet ikkonfermata l-ebda azzjoni.",
    "system.controls.error.generationConflict":
      "L-istat tal-broker inbidel wara li nqara; ma ġiet applikata l-ebda azzjoni.",
    "system.controls.error.instanceChanged":
      "L-istanza tal-broker inbidlet. Aġġorna l-istat qabel taġixxi.",
    "system.controls.error.reconciliationRequired":
      "Il-broker għandu xogħol mhux solvut. It-tkomplija u l-bidu huma diżattivati sakemm jiġi rikonċiljat.",
    "system.controls.error.capabilityUnavailable":
      "Dan il-kontroll mhuwiex disponibbli: {reason}.",
    "system.controls.accessible.status":
      "L-istat tal-kontroll tal-broker kondiviż.",
    "system.controls.accessible.globalScope":
      "Japplika globalment għat-talbiet ġestiti tal-proġetti kollha.",
    "system.controls.accessible.pending":
      "Qed jistenna rċevuta awtorevoli tal-broker.",
    "system.controls.accessible.action": "{action} il-broker kondiviż.",
    "system.controls.accessible.disabled":
      "{action} mhuwiex disponibbli: {reason}.",
  },
  pl: {
    "system.controls.title": "Sterowanie wspólnym brokerem.",
    "system.controls.scope.project":
      "To globalne sterowanie jedynym wspólnym brokerem; wpływa na wszystkie projekty, w tym {projectName}.",
    "system.controls.scope.managedOnly":
      "Pauza zatrzymuje tylko nowe żądania zarządzane przez fmcad. Nie zatrzymuje Fusion ani innych aplikacji.",
    "system.controls.status.label": "Stan brokera.",
    "system.controls.phase.running": "Przyjmuje zarządzane żądania.",
    "system.controls.phase.paused":
      "Wstrzymano. Nowe zarządzane żądania są zatrzymywane.",
    "system.controls.phase.pausing":
      "Wstrzymywanie; aktywne zarządzane żądania mogą nadal działać.",
    "system.controls.phase.draining":
      "Opróżnianie kolejki; oczekiwanie na {activeOperations} aktywnych zarządzanych żądań.",
    "system.controls.phase.stopped": "Zatrzymano.",
    "system.controls.phase.unknown": "Stan brokera jest nieznany.",
    "system.controls.phase.recoveryBlocked":
      "Nierozstrzygnięte operacje brokera wymagają uzgodnienia; sterowanie jest wyłączone.",
    "system.controls.phase.offline":
      "Broker jest offline; bieżący stan jest niedostępny.",
    "system.controls.action.pause": "Przestań przyjmować żądania.",
    "system.controls.action.drain": "Wstrzymaj i dokończ aktywne żądania.",
    "system.controls.action.resume": "Wznów przyjmowanie żądań.",
    "system.controls.action.start": "Uruchom brokera.",
    "system.controls.action.refresh": "Odśwież stan brokera.",
    "system.controls.action.reconcile": "Sprawdź pierwotne żądanie.",
    "system.controls.action.pending": "Oczekiwanie na potwierdzenie brokera.",
    "system.controls.action.confirmed": "Broker potwierdził: {phase}.",
    "system.controls.action.unknown":
      "Wynik jest nieznany. Sprawdzamy pierwotne potwierdzenie; działanie nie zostanie wysłane ponownie.",
    "system.controls.action.receiptPending":
      "Pierwotne żądanie oczekuje. Sprawdzamy jego potwierdzenie; drugie działanie nie zostanie wysłane.",
    "system.controls.safety.noReplay":
      "Nie ponawiaj działania, gdy jego potwierdzenie oczekuje lub wynik jest nieznany.",
    "system.controls.error.unauthorized":
      "Nie masz uprawnień do sterowania wspólnym brokerem.",
    "system.controls.error.storageUnavailable":
      "Trwały magazyn przeglądarki jest niedostępny. Sterowanie jest wyłączone, aby zapobiec ponowieniu działania.",
    "system.controls.error.unsupported":
      "Ten broker nie obsługuje działania: {action}.",
    "system.controls.error.offline":
      "Broker jest offline. Nie potwierdzono żadnego działania.",
    "system.controls.error.generationConflict":
      "Stan brokera zmienił się po odczycie; nie zastosowano żadnego działania.",
    "system.controls.error.instanceChanged":
      "Instancja brokera uległa zmianie. Odśwież stan przed wykonaniem działania.",
    "system.controls.error.reconciliationRequired":
      "Broker ma nierozstrzygnięte operacje. Wznawianie i uruchamianie są wyłączone do czasu ich uzgodnienia.",
    "system.controls.error.capabilityUnavailable":
      "To sterowanie jest niedostępne: {reason}.",
    "system.controls.accessible.status": "Stan sterowania wspólnym brokerem.",
    "system.controls.accessible.globalScope":
      "Dotyczy globalnie zarządzanych żądań ze wszystkich projektów.",
    "system.controls.accessible.pending":
      "Oczekiwanie na wiarygodne potwierdzenie brokera.",
    "system.controls.accessible.action": "{action} wspólnym brokerem.",
    "system.controls.accessible.disabled":
      "{action} jest niedostępne: {reason}.",
  },
  pt: {
    "system.controls.title": "Controlo do broker partilhado.",
    "system.controls.scope.project":
      "Este é o controlo global do único broker partilhado; afeta todos os projetos, incluindo {projectName}.",
    "system.controls.scope.managedOnly":
      "A pausa bloqueia apenas novos pedidos geridos pelo fmcad. Não para o Fusion nem outras aplicações.",
    "system.controls.status.label": "Estado do broker.",
    "system.controls.phase.running": "Aceita pedidos geridos.",
    "system.controls.phase.paused":
      "Em pausa. Os novos pedidos geridos ficam retidos.",
    "system.controls.phase.pausing":
      "A colocar em pausa; os pedidos geridos ativos ainda podem estar em execução.",
    "system.controls.phase.draining":
      "A concluir pedidos; à espera de {activeOperations} pedidos geridos ativos.",
    "system.controls.phase.stopped": "Parado.",
    "system.controls.phase.unknown": "O estado do broker é desconhecido.",
    "system.controls.phase.recoveryBlocked":
      "O trabalho por resolver do broker requer reconciliação; os controlos estão desativados.",
    "system.controls.phase.offline":
      "O broker está offline; o estado atual não está disponível.",
    "system.controls.action.pause": "Deixar de aceitar pedidos.",
    "system.controls.action.drain": "Pausar e concluir pedidos ativos.",
    "system.controls.action.resume": "Retomar a aceitação de pedidos.",
    "system.controls.action.start": "Iniciar broker.",
    "system.controls.action.refresh": "Atualizar estado do broker.",
    "system.controls.action.reconcile": "Verificar pedido original.",
    "system.controls.action.pending": "À espera da confirmação do broker.",
    "system.controls.action.confirmed": "O broker confirmou: {phase}.",
    "system.controls.action.unknown":
      "Resultado desconhecido. A verificar o recibo original; a ação não será enviada novamente.",
    "system.controls.action.receiptPending":
      "O pedido original está pendente. A verificar o respetivo recibo; não será enviada uma segunda ação.",
    "system.controls.safety.noReplay":
      "Não repita uma ação enquanto o recibo estiver pendente ou o resultado for desconhecido.",
    "system.controls.error.unauthorized":
      "Não tem autorização para controlar o broker partilhado.",
    "system.controls.error.storageUnavailable":
      "O armazenamento persistente do navegador não está disponível. Os controlos estão desativados para evitar a repetição da ação.",
    "system.controls.error.unsupported": "Este broker não suporta {action}.",
    "system.controls.error.offline":
      "O broker está offline. Nenhuma ação foi confirmada.",
    "system.controls.error.generationConflict":
      "O estado do broker mudou após a leitura; não foi aplicada nenhuma ação.",
    "system.controls.error.instanceChanged":
      "A instância do broker mudou. Atualize o estado antes de agir.",
    "system.controls.error.reconciliationRequired":
      "O broker tem trabalho por resolver. Retomar e iniciar estão desativados até à reconciliação.",
    "system.controls.error.capabilityUnavailable":
      "Este controlo não está disponível: {reason}.",
    "system.controls.accessible.status":
      "Estado do controlo do broker partilhado.",
    "system.controls.accessible.globalScope":
      "Aplica-se globalmente aos pedidos geridos de todos os projetos.",
    "system.controls.accessible.pending":
      "À espera de um recibo autorizado do broker.",
    "system.controls.accessible.action": "{action} o broker partilhado.",
    "system.controls.accessible.disabled": "{action} indisponível: {reason}.",
  },
  ro: {
    "system.controls.title": "Controlul brokerului partajat.",
    "system.controls.scope.project":
      "Acesta este controlul global al singurului broker partajat; afectează toate proiectele, inclusiv {projectName}.",
    "system.controls.scope.managedOnly":
      "Pauzarea oprește doar cererile noi gestionate de fmcad. Nu oprește Fusion sau alte aplicații.",
    "system.controls.status.label": "Starea brokerului.",
    "system.controls.phase.running": "Acceptă cereri gestionate.",
    "system.controls.phase.paused":
      "În pauză. Cererile gestionate noi sunt reținute.",
    "system.controls.phase.pausing":
      "Se pune în pauză; cererile gestionate active pot încă rula.",
    "system.controls.phase.draining":
      "Se finalizează; se așteaptă {activeOperations} cereri gestionate active.",
    "system.controls.phase.stopped": "Oprit.",
    "system.controls.phase.unknown": "Starea brokerului este necunoscută.",
    "system.controls.phase.recoveryBlocked":
      "Activitatea nerezolvată a brokerului necesită reconciliere; comenzile sunt dezactivate.",
    "system.controls.phase.offline":
      "Brokerul este offline; starea actuală nu este disponibilă.",
    "system.controls.action.pause": "Oprește acceptarea cererilor.",
    "system.controls.action.drain":
      "Pune pe pauză și finalizează cererile active.",
    "system.controls.action.resume": "Reia acceptarea cererilor.",
    "system.controls.action.start": "Pornește brokerul.",
    "system.controls.action.refresh": "Reîmprospătează starea brokerului.",
    "system.controls.action.reconcile": "Verifică cererea inițială.",
    "system.controls.action.pending": "Se așteaptă confirmarea brokerului.",
    "system.controls.action.confirmed": "Brokerul a confirmat: {phase}.",
    "system.controls.action.unknown":
      "Rezultatul este necunoscut. Se verifică dovada inițială; acțiunea nu va fi trimisă din nou.",
    "system.controls.action.receiptPending":
      "Cererea inițială este în așteptare. Se verifică dovada; nu va fi trimisă o a doua acțiune.",
    "system.controls.safety.noReplay":
      "Nu repetați o acțiune cât timp dovada ei este în așteptare sau rezultatul este necunoscut.",
    "system.controls.error.unauthorized":
      "Nu sunteți autorizat să controlați brokerul partajat.",
    "system.controls.error.storageUnavailable":
      "Stocarea persistentă a browserului nu este disponibilă. Comenzile sunt dezactivate pentru a preveni repetarea acțiunii.",
    "system.controls.error.unsupported": "Acest broker nu acceptă {action}.",
    "system.controls.error.offline":
      "Brokerul este offline. Nicio acțiune nu a fost confirmată.",
    "system.controls.error.generationConflict":
      "Starea brokerului s-a schimbat după citire; nu s-a aplicat nicio acțiune.",
    "system.controls.error.instanceChanged":
      "Instanța brokerului s-a schimbat. Reîmprospătați starea înainte de a acționa.",
    "system.controls.error.reconciliationRequired":
      "Brokerul are activitate nerezolvată. Reluarea și pornirea sunt dezactivate până la reconciliere.",
    "system.controls.error.capabilityUnavailable":
      "Acest control nu este disponibil: {reason}.",
    "system.controls.accessible.status":
      "Starea controlului brokerului partajat.",
    "system.controls.accessible.globalScope":
      "Se aplică global cererilor gestionate din toate proiectele.",
    "system.controls.accessible.pending":
      "Se așteaptă dovada autorizată a brokerului.",
    "system.controls.accessible.action": "{action} brokerul partajat.",
    "system.controls.accessible.disabled":
      "{action} nu este disponibil: {reason}.",
  },
  sk: {
    "system.controls.title": "Ovládanie zdieľaného brokera.",
    "system.controls.scope.project":
      "Ide o globálne ovládanie jediného zdieľaného brokera; ovplyvňuje všetky projekty vrátane projektu {projectName}.",
    "system.controls.scope.managedOnly":
      "Pozastavenie zastaví iba nové požiadavky spravované systémom fmcad. Nezastaví Fusion ani iné aplikácie.",
    "system.controls.status.label": "Stav brokera.",
    "system.controls.phase.running": "Prijíma spravované požiadavky.",
    "system.controls.phase.paused":
      "Pozastavené. Nové spravované požiadavky sa zadržiavajú.",
    "system.controls.phase.pausing":
      "Pozastavuje sa; aktívne spravované požiadavky môžu stále bežať.",
    "system.controls.phase.draining":
      "Dokončujú sa požiadavky; čaká sa na {activeOperations} aktívnych spravovaných požiadaviek.",
    "system.controls.phase.stopped": "Zastavené.",
    "system.controls.phase.unknown": "Stav brokera nie je známy.",
    "system.controls.phase.recoveryBlocked":
      "Nevyriešená práca brokera vyžaduje zosúladenie; ovládacie prvky sú vypnuté.",
    "system.controls.phase.offline":
      "Broker je offline; aktuálny stav nie je dostupný.",
    "system.controls.action.pause": "Prestať prijímať požiadavky.",
    "system.controls.action.drain": "Pozastaviť a dokončiť aktívne požiadavky.",
    "system.controls.action.resume": "Obnoviť prijímanie požiadaviek.",
    "system.controls.action.start": "Spustiť brokera.",
    "system.controls.action.refresh": "Obnoviť stav brokera.",
    "system.controls.action.reconcile": "Skontrolovať pôvodnú požiadavku.",
    "system.controls.action.pending": "Čaká sa na potvrdenie od brokera.",
    "system.controls.action.confirmed": "Broker potvrdil: {phase}.",
    "system.controls.action.unknown":
      "Výsledok nie je známy. Kontroluje sa pôvodné potvrdenie; akcia sa znova neodošle.",
    "system.controls.action.receiptPending":
      "Pôvodná požiadavka čaká. Kontroluje sa jej potvrdenie; druhá akcia sa neodošle.",
    "system.controls.safety.noReplay":
      "Neopakujte akciu, kým jej potvrdenie čaká alebo jej výsledok nie je známy.",
    "system.controls.error.unauthorized":
      "Nemáte oprávnenie ovládať zdieľaného brokera.",
    "system.controls.error.storageUnavailable":
      "Trvalé úložisko prehliadača nie je dostupné. Ovládanie je vypnuté, aby sa zabránilo opakovaniu akcie.",
    "system.controls.error.unsupported":
      "Tento broker nepodporuje akciu {action}.",
    "system.controls.error.offline":
      "Broker je offline. Žiadna akcia nebola potvrdená.",
    "system.controls.error.generationConflict":
      "Stav brokera sa po načítaní zmenil; nevykonala sa žiadna akcia.",
    "system.controls.error.instanceChanged":
      "Inštancia brokera sa zmenila. Pred akciou obnovte stav.",
    "system.controls.error.reconciliationRequired":
      "Broker má nevyriešenú prácu. Obnovenie a spustenie sú vypnuté až do jej zosúladenia.",
    "system.controls.error.capabilityUnavailable":
      "Toto ovládanie nie je dostupné: {reason}.",
    "system.controls.accessible.status": "Stav ovládania zdieľaného brokera.",
    "system.controls.accessible.globalScope":
      "Globálne sa vzťahuje na spravované požiadavky zo všetkých projektov.",
    "system.controls.accessible.pending":
      "Čaká sa na záväzné potvrdenie brokera.",
    "system.controls.accessible.action": "{action} zdieľaného brokera.",
    "system.controls.accessible.disabled":
      "Akcia {action} nie je dostupná: {reason}.",
  },
  sl: {
    "system.controls.title": "Upravljanje skupnim posrednikom.",
    "system.controls.scope.project":
      "To je globalno upravljanje edinega skupnega posrednika; vpliva na vse projekte, vključno s projektom {projectName}.",
    "system.controls.scope.managedOnly":
      "Začasna ustavitev zaustavi samo nove zahteve, ki jih upravlja fmcad. Ne ustavi programa Fusion ali drugih aplikacij.",
    "system.controls.status.label": "Stanje posrednika.",
    "system.controls.phase.running": "Sprejema upravljane zahteve.",
    "system.controls.phase.paused":
      "Začasno ustavljeno. Nove upravljane zahteve čakajo.",
    "system.controls.phase.pausing":
      "Začasna ustavitev; aktivne upravljane zahteve se morda še izvajajo.",
    "system.controls.phase.draining":
      "Zaključevanje; čaka se na {activeOperations} aktivnih upravljanih zahtev.",
    "system.controls.phase.stopped": "Ustavljeno.",
    "system.controls.phase.unknown": "Stanje posrednika ni znano.",
    "system.controls.phase.recoveryBlocked":
      "Nerazrešeno delo posrednika je treba uskladiti; kontrolniki so onemogočeni.",
    "system.controls.phase.offline":
      "Posrednik nima povezave; trenutno stanje ni na voljo.",
    "system.controls.action.pause": "Ustavi sprejemanje zahtev.",
    "system.controls.action.drain":
      "Začasno ustavi in dokončaj aktivne zahteve.",
    "system.controls.action.resume": "Nadaljuj sprejemanje zahtev.",
    "system.controls.action.start": "Zaženi posrednika.",
    "system.controls.action.refresh": "Osveži stanje posrednika.",
    "system.controls.action.reconcile": "Preveri prvotno zahtevo.",
    "system.controls.action.pending": "Čaka se na potrditev posrednika.",
    "system.controls.action.confirmed": "Posrednik je potrdil: {phase}.",
    "system.controls.action.unknown":
      "Izid ni znan. Preverja se prvotno potrdilo; dejanje ne bo znova poslano.",
    "system.controls.action.receiptPending":
      "Prvotna zahteva čaka. Preverja se njeno potrdilo; drugo dejanje ne bo poslano.",
    "system.controls.safety.noReplay":
      "Ne ponavljajte dejanja, dokler potrdilo čaka ali izid ni znan.",
    "system.controls.error.unauthorized":
      "Nimate dovoljenja za upravljanje skupnega posrednika.",
    "system.controls.error.storageUnavailable":
      "Trajna shramba brskalnika ni na voljo. Kontrolniki so onemogočeni, da se prepreči ponovitev dejanja.",
    "system.controls.error.unsupported":
      "Ta posrednik ne podpira dejanja {action}.",
    "system.controls.error.offline":
      "Posrednik nima povezave. Nobeno dejanje ni bilo potrjeno.",
    "system.controls.error.generationConflict":
      "Stanje posrednika se je po branju spremenilo; dejanje ni bilo uporabljeno.",
    "system.controls.error.instanceChanged":
      "Primerek posrednika se je spremenil. Pred dejanjem osvežite stanje.",
    "system.controls.error.reconciliationRequired":
      "Posrednik ima nerazrešeno delo. Nadaljevanje in zagon sta onemogočena do uskladitve.",
    "system.controls.error.capabilityUnavailable":
      "Ta kontrolnik ni na voljo: {reason}.",
    "system.controls.accessible.status":
      "Stanje upravljanja skupnega posrednika.",
    "system.controls.accessible.globalScope":
      "Globalno velja za upravljane zahteve iz vseh projektov.",
    "system.controls.accessible.pending":
      "Čaka se na verodostojno potrdilo posrednika.",
    "system.controls.accessible.action": "{action} skupnega posrednika.",
    "system.controls.accessible.disabled":
      "Dejanje {action} ni na voljo: {reason}.",
  },
  es: {
    "system.controls.title": "Control del broker compartido.",
    "system.controls.scope.project":
      "Este es el control global del único agente compartido; afecta a todos los proyectos, incluido {projectName}.",
    "system.controls.scope.managedOnly":
      "La pausa detiene solo las nuevas solicitudes gestionadas por fmcad. No detiene Fusion ni otras aplicaciones.",
    "system.controls.status.label": "Estado del broker.",
    "system.controls.phase.running": "Acepta solicitudes gestionadas.",
    "system.controls.phase.paused":
      "En pausa. Las nuevas solicitudes gestionadas quedan retenidas.",
    "system.controls.phase.pausing":
      "Pausando; las solicitudes gestionadas activas aún pueden estar ejecutándose.",
    "system.controls.phase.draining":
      "Finalizando; esperando {activeOperations} solicitudes gestionadas activas.",
    "system.controls.phase.stopped": "Detenido.",
    "system.controls.phase.unknown": "Se desconoce el estado del broker.",
    "system.controls.phase.recoveryBlocked":
      "El trabajo sin resolver del broker requiere conciliación; los controles están desactivados.",
    "system.controls.phase.offline":
      "El broker está desconectado; el estado actual no está disponible.",
    "system.controls.action.pause": "Dejar de aceptar solicitudes.",
    "system.controls.action.drain":
      "Pausar y finalizar las solicitudes activas.",
    "system.controls.action.resume": "Reanudar la aceptación de solicitudes.",
    "system.controls.action.start": "Iniciar agente.",
    "system.controls.action.refresh": "Actualizar el estado del agente.",
    "system.controls.action.reconcile": "Comprobar la solicitud original.",
    "system.controls.action.pending": "Esperando la confirmación del agente.",
    "system.controls.action.confirmed": "El agente confirmó: {phase}.",
    "system.controls.action.unknown":
      "Resultado desconocido. Se comprueba el recibo original; la acción no se volverá a enviar.",
    "system.controls.action.receiptPending":
      "La solicitud original está pendiente. Se comprueba su recibo; no se enviará una segunda acción.",
    "system.controls.safety.noReplay":
      "No repitas una acción mientras su recibo esté pendiente o el resultado sea desconocido.",
    "system.controls.error.unauthorized":
      "No tienes autorización para controlar el broker compartido.",
    "system.controls.error.storageUnavailable":
      "El almacenamiento persistente del navegador no está disponible. Los controles están desactivados para evitar repetir la acción.",
    "system.controls.error.unsupported": "Este agente no admite {action}.",
    "system.controls.error.offline":
      "El agente está desconectado. No se confirmó ninguna acción.",
    "system.controls.error.generationConflict":
      "El estado del broker cambió después de leerlo; no se aplicó ninguna acción.",
    "system.controls.error.instanceChanged":
      "La instancia del broker cambió. Actualiza el estado antes de actuar.",
    "system.controls.error.reconciliationRequired":
      "El broker tiene trabajo sin resolver. Reanudar e iniciar están desactivados hasta conciliarlo.",
    "system.controls.error.capabilityUnavailable":
      "Este control no está disponible: {reason}.",
    "system.controls.accessible.status":
      "Estado del control del broker compartido.",
    "system.controls.accessible.globalScope":
      "Se aplica globalmente a las solicitudes gestionadas de todos los proyectos.",
    "system.controls.accessible.pending":
      "Esperando el recibo autorizado del agente.",
    "system.controls.accessible.action": "{action} el broker compartido.",
    "system.controls.accessible.disabled":
      "{action} no está disponible: {reason}.",
  },
  sv: {
    "system.controls.title": "Styrning av delad broker.",
    "system.controls.scope.project":
      "Detta är global styrning av den enda delade brokern; den påverkar alla projekt, inklusive {projectName}.",
    "system.controls.scope.managedOnly":
      "Paus stoppar endast nya fmcad-hanterade förfrågningar. Den stoppar inte Fusion eller andra program.",
    "system.controls.status.label": "Brokerstatus.",
    "system.controls.phase.running": "Tar emot hanterade förfrågningar.",
    "system.controls.phase.paused":
      "Pausad. Nya hanterade förfrågningar hålls tillbaka.",
    "system.controls.phase.pausing":
      "Pausar; aktiva hanterade förfrågningar kan fortfarande köras.",
    "system.controls.phase.draining":
      "Slutför; väntar på {activeOperations} aktiva hanterade förfrågningar.",
    "system.controls.phase.stopped": "Stoppad.",
    "system.controls.phase.unknown": "Brokerstatus är okänd.",
    "system.controls.phase.recoveryBlocked":
      "Olöst brokerarbete måste stämmas av; kontrollerna är inaktiverade.",
    "system.controls.phase.offline":
      "Broker är offline; aktuell status är inte tillgänglig.",
    "system.controls.action.pause": "Sluta ta emot förfrågningar.",
    "system.controls.action.drain": "Pausa och slutför aktiva förfrågningar.",
    "system.controls.action.resume": "Återuppta mottagning av förfrågningar.",
    "system.controls.action.start": "Starta broker.",
    "system.controls.action.refresh": "Uppdatera brokerstatus.",
    "system.controls.action.reconcile":
      "Kontrollera den ursprungliga förfrågan.",
    "system.controls.action.pending": "Väntar på bekräftelse från broker.",
    "system.controls.action.confirmed": "Broker bekräftade: {phase}.",
    "system.controls.action.unknown":
      "Resultatet är okänt. Det ursprungliga kvittot kontrolleras; åtgärden skickas inte igen.",
    "system.controls.action.receiptPending":
      "Den ursprungliga förfrågan väntar. Kvittot kontrolleras; ingen andra åtgärd skickas.",
    "system.controls.safety.noReplay":
      "Upprepa inte en åtgärd medan kvittot väntar eller resultatet är okänt.",
    "system.controls.error.unauthorized":
      "Du har inte behörighet att styra den delade brokern.",
    "system.controls.error.storageUnavailable":
      "Webbläsarens beständiga lagring är inte tillgänglig. Kontrollerna är inaktiverade för att förhindra att åtgärden upprepas.",
    "system.controls.error.unsupported":
      "Den här brokern stöder inte {action}.",
    "system.controls.error.offline":
      "Broker är offline. Ingen åtgärd bekräftades.",
    "system.controls.error.generationConflict":
      "Brokerstatus ändrades efter avläsningen; ingen åtgärd utfördes.",
    "system.controls.error.instanceChanged":
      "Brokerinstansen ändrades. Uppdatera status innan du agerar.",
    "system.controls.error.reconciliationRequired":
      "Brokern har olöst arbete. Återuppta och starta är inaktiverade tills det har stämts av.",
    "system.controls.error.capabilityUnavailable":
      "Den här kontrollen är inte tillgänglig: {reason}.",
    "system.controls.accessible.status": "Status för delad brokerstyrning.",
    "system.controls.accessible.globalScope":
      "Gäller globalt för hanterade förfrågningar från alla projekt.",
    "system.controls.accessible.pending":
      "Väntar på ett auktoritativt brokerkvitto.",
    "system.controls.accessible.action": "{action} den delade brokern.",
    "system.controls.accessible.disabled":
      "{action} är inte tillgänglig: {reason}.",
  },
  uk: {
    "system.controls.title": "Керування спільним брокером.",
    "system.controls.scope.project":
      "Це глобальне керування єдиним спільним брокером; воно впливає на всі проєкти, зокрема {projectName}.",
    "system.controls.scope.managedOnly":
      "Призупинення зупиняє лише нові запити під керуванням fmcad. Воно не зупиняє Fusion чи інші програми.",
    "system.controls.status.label": "Стан брокера.",
    "system.controls.phase.running": "Приймає керовані запити.",
    "system.controls.phase.paused":
      "Призупинено. Нові керовані запити затримуються.",
    "system.controls.phase.pausing":
      "Призупинення; активні керовані запити можуть іще виконуватися.",
    "system.controls.phase.draining":
      "Завершення; очікування на {activeOperations} активних керованих запитів.",
    "system.controls.phase.stopped": "Зупинено.",
    "system.controls.phase.unknown": "Стан брокера невідомий.",
    "system.controls.phase.recoveryBlocked":
      "Невирішену роботу брокера потрібно узгодити; елементи керування вимкнено.",
    "system.controls.phase.offline":
      "Брокер не в мережі; поточний стан недоступний.",
    "system.controls.action.pause": "Припинити приймати запити.",
    "system.controls.action.drain": "Призупинити й завершити активні запити.",
    "system.controls.action.resume": "Відновити приймання запитів.",
    "system.controls.action.start": "Запустити брокер.",
    "system.controls.action.refresh": "Оновити стан брокера.",
    "system.controls.action.reconcile": "Перевірити початковий запит.",
    "system.controls.action.pending": "Очікування на підтвердження брокера.",
    "system.controls.action.confirmed": "Брокер підтвердив: {phase}.",
    "system.controls.action.unknown":
      "Результат невідомий. Перевіряється початкове підтвердження; дію не буде надіслано повторно.",
    "system.controls.action.receiptPending":
      "Початковий запит очікує. Перевіряється його підтвердження; другу дію не буде надіслано.",
    "system.controls.safety.noReplay":
      "Не повторюйте дію, доки її підтвердження очікує або результат невідомий.",
    "system.controls.error.unauthorized":
      "Ви не маєте дозволу керувати спільним брокером.",
    "system.controls.error.storageUnavailable":
      "Постійне сховище браузера недоступне. Керування вимкнено, щоб запобігти повторному виконанню дії.",
    "system.controls.error.unsupported":
      "Цей брокер не підтримує дію {action}.",
    "system.controls.error.offline":
      "Брокер не в мережі. Жодну дію не підтверджено.",
    "system.controls.error.generationConflict":
      "Стан брокера змінився після зчитування; дію не виконано.",
    "system.controls.error.instanceChanged":
      "Екземпляр брокера змінився. Оновіть стан перед виконанням дії.",
    "system.controls.error.reconciliationRequired":
      "У брокера є невирішена робота. Відновлення й запуск вимкнено до її узгодження.",
    "system.controls.error.capabilityUnavailable":
      "Цей засіб керування недоступний: {reason}.",
    "system.controls.accessible.status": "Стан керування спільним брокером.",
    "system.controls.accessible.globalScope":
      "Глобально застосовується до керованих запитів з усіх проєктів.",
    "system.controls.accessible.pending":
      "Очікування на офіційне підтвердження брокера.",
    "system.controls.accessible.action": "{action} спільним брокером.",
    "system.controls.accessible.disabled": "Дія {action} недоступна: {reason}.",
  },
} as const satisfies Record<
  LocaleCode,
  Readonly<
    Record<
      Exclude<SystemControlMessageKey, "system.controls.confirm.cancel">,
      MessageValue
    >
  >
>;

const systemControlCancel = {
  bg: "Отказ",
  hr: "Odustani",
  cs: "Zrušit",
  da: "Annuller",
  nl: "Annuleren",
  en: "Cancel",
  et: "Tühista",
  fi: "Peruuta",
  fr: "Annuler",
  de: "Abbrechen",
  el: "Ακύρωση",
  hu: "Mégse",
  ga: "Cealaigh",
  it: "Annulla",
  lv: "Atcelt",
  lt: "Atšaukti",
  mt: "Ikkanċella",
  pl: "Anuluj",
  pt: "Cancelar",
  ro: "Anulează",
  sk: "Zrušiť",
  sl: "Prekliči",
  es: "Cancelar",
  sv: "Avbryt",
  uk: "Скасувати",
} as const satisfies Record<LocaleCode, string>;

export const SYSTEM_CONTROL_CATALOGS = Object.fromEntries(
  Object.keys(systemControlCatalogs).map((locale) => [
    locale,
    {
      ...systemControlCatalogs[locale as LocaleCode],
      "system.controls.confirm.cancel":
        systemControlCancel[locale as LocaleCode],
    },
  ]),
) as Readonly<Record<LocaleCode, SystemControlCatalog>>;
