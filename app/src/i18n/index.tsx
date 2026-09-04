/*
 * Three languages, one mechanism, no library.
 *
 * `t(key, fallback)` is the whole API. English is not a dictionary — it is the fallback
 * string written where the text is used, so the source stays readable and a missing key
 * can never render as `nav.expenses`. German and Russian override by key; anything they
 * have not translated yet falls back to English rather than to a blank, which makes
 * partial coverage a state the app can ship in instead of a bug.
 *
 * The choice lives in `localStorage['twm.lang']` — a device preference, like the active
 * person and the theme, because a household shares one installation. First launch guesses
 * from the browser's language and guesses conservatively: anything that is not German or
 * Russian is English.
 *
 * What this deliberately does not cover: text the server composes (the statement, the
 * settlement sentence, error messages from CAP) and the SAP joke vocabulary where it *is*
 * the joke. Those are decisions per string, not a gap in the mechanism.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Lang = 'en' | 'de' | 'ru'

export const LANG_KEY = 'twm.lang'

export const LANGUAGES: ReadonlyArray<{ code: Lang; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
]

type Dictionary = Readonly<Record<string, string>>

const de: Dictionary = {
  'home.nav': 'Alles in der App',
  'home.section.money': 'Das Geld',
  'home.section.together': 'Gemeinsame Zeit',
  'home.section.us': 'Wir beide',
  'home.section.app': 'Die App',

  // The commons (ADR-003)
  'commons.nav': 'Gemeinsames',
  'commons.tonight': 'Heute Abend',
  'commons.places': 'Orte',
  'commons.ideas': 'Ideen',
  'commons.rate': 'Ort bewerten',
  'tonight.lede':
    'Drei Abende, die bei anderen Haushalten funktioniert haben. Nimm einen, oder keinen.',
  'tonight.budget': 'Höchstens, pro Person',
  'tonight.any': 'Egal',
  'tonight.empty': 'Noch nichts zu verteilen.',
  'tonight.emptyHint':
    'Ein Ort erscheint hier, sobald drei Haushalte ihn bewertet haben. Bewerte einen Ort, den ihr mögt, und es füllt sich — euer eigener eingeschlossen.',
  'tonight.footnote': 'Für heute ausgeteilt. Morgen sind es andere.',
  'places.empty': 'Noch nichts in eurer Nähe.',
  'places.emptyFiltered': 'Nichts in eurer Nähe passt dazu.',
  'places.emptyHint':
    'Ein Ort erscheint, sobald drei Haushalte ihn bewertet haben — genug, dass kein einzelner Haushalt erkennbar ist. Bewertet einen Ort, den ihr mögt, und es füllt sich.',
  'places.everything': 'Alles',
  'ideas.ledeDo': 'Dinge, die keine Reservierung und keine Datenbank brauchen.',
  'ideas.ledeGive': 'Geschenke, die kein Gutschein sind.',
  'ideas.toDo': 'Zu tun',
  'ideas.toGive': 'Zu schenken',
  'tile.tonight.label': 'Heute Abend',
  'tile.tonight.value': 'Drei',
  'tile.tonight.caption': 'Abende, die funktioniert haben',

  // Shell
  'app.tagline': 'Haushalts-Date-Management',
  'nav.home': 'Start',
  'nav.scan': 'Scannen',
  'nav.expenses': 'Ausgaben',
  'nav.events': 'Ereignisse',
  'nav.memories': 'Erinnerungen',
  'nav.more': 'Mehr',
  'shell.signout': 'Abmelden',
  'shell.signingout': 'Abmelden…',
  'shell.switcher.title': 'Wer schaut gerade?',

  // Home tiles
  // Wallet, Dance and "On your mind" — CONTRACTS §16–§19.
  'tile.wallet.label': 'Guthaben',
  'tile.wallet.hint': 'Punkte und hinterlegte Karten',
  'tile.wallet.value': 'Punkte',
  'tile.wallet.caption': 'und Karten',
  'tile.dance.label': 'Tanzen',
  'tile.dance.hint': 'Einen Schritt lernen, zusammen',
  'tile.dance.value': 'Vier',
  'tile.dance.caption': 'Schritte zum Üben',
  'tile.reflect.label': 'Was dich beschäftigt',
  'tile.reflect.hint': 'Aufschreiben, ganz privat',
  'tile.reflect.value': 'Schreiben',
  'tile.reflect.caption': 'nur für dich',
  'tile.scan.label': 'Scannen',
  'tile.scan.hint': 'Beleg fotografieren',
  'tile.mood.label': 'Stimmung',
  'tile.mood.hint': 'Wie geht es dir heute?',
  'tile.mood.value': 'Check-in',
  'tile.mood.caption': 'zwei Sekunden',
  'tile.ledger.label': 'Ausgaben',
  'tile.ledger.hint': 'Buchungen und Zahlläufe',
  'tile.events.label': 'Ereignisse',
  'tile.events.hint': 'Reisen, Abende, Pläne',
  'tile.calendar.label': 'Kalender',
  'tile.calendar.hint': 'Was als Nächstes ansteht',
  'tile.memories.label': 'Erinnerungen',
  'tile.memories.hint': 'Die Zeitleiste von uns',
  'tile.statement.label': 'Abschluss',
  'tile.statement.hint': 'Das Jahr in einem Brief',
  'tile.settings.label': 'Einstellungen',
  'tile.settings.hint': 'Personen, Import, System',
  'tile.howItWorks.label': 'So funktioniert es',
  'tile.howItWorks.hint': 'Der Klassifikator, erklärt',

  // Login
  'login.tagline': 'Date-Management für zwei',
  'login.username': 'Anmeldename',
  'login.password': 'Passwort',
  'login.submit': 'Anmelden',
  'login.working': 'Anmelden…',

  // Mood
  'mood.title': 'Stimmung',
  'mood.hint.named': 'Wie geht es {name}? Tippe ein Gesicht — oder lass die Kamera raten.',
  'mood.hint.today': 'Wie läuft der Tag? Tippe ein Gesicht — oder lass die Kamera raten.',
  'mood.level.1': 'Schwer',
  'mood.level.2': 'Mau',
  'mood.level.3': 'Okay',
  'mood.level.4': 'Gut',
  'mood.level.5': 'Super',
  'mood.note.placeholder': 'Ein Satz dazu, wenn du magst (optional)',
  'mood.save': 'Stimmung speichern',
  'mood.saving': 'Speichern…',
  'mood.scan': 'Gesicht scannen',
  'mood.scanning': 'Schaue…',
  'mood.privacy':
    'Das Foto wird ausgewertet und sofort verworfen — gespeichert wird nur die Einschätzung.',
  'mood.detection.off':
    'Gesichtserkennung ist aus — der Server hat keinen KI-Schlüssel. Die Auswahl oben funktioniert ohne.',
  'mood.saved': 'Gespeichert. Komm wieder, wenn das Wetter umschlägt.',
  'mood.lately': 'Zuletzt',
  'mood.empty':
    'Noch nichts. Der erste Eintrag dauert zwei Sekunden; das Jahresbild besteht aus dreihundert davon.',
  'mood.camera.read': 'Kamera las: {label}',

  // Scan
  'scan.title': 'Scannen',
  'scan.hint':
    'Fotografiere einen Beleg. Document AI liest ihn, der Klassifikator ordnet ihn ein, du bestätigst.',
  'scan.mock':
    'Demo-Extraktion — es sind keine Document-AI-Zugangsdaten hinterlegt. Diese Beträge stammen aus einem Beispielbeleg, nicht aus deinem Foto. Prüfe jedes Feld vor dem Buchen.',

  // Settings
  'settings.title': 'Einstellungen',
  'settings.language.title': 'Sprache',
  'settings.language.subtitle':
    'Gilt für dieses Gerät. Drei zur Auswahl; Zahlen bleiben Schweizer Art.',
  'settings.session.title': 'Sitzung',
  'settings.session.subtitle': 'Wer hier angemeldet ist — und wie man das beendet.',
  'settings.session.signedInAs':
    'Angemeldet als {name}. Sitzungen gelten eine Woche, nur in diesem Browser.',
  'settings.session.anonymous': 'Dieser Browser hat eine Sitzung im Hauptbuch.',

  // Version & updates
  'update.ready': 'Eine neue Version ist bereit.',
  'update.reload': 'Neu laden',
  'update.reloading': 'Lädt neu…',
  'update.later': 'Später',
  'version.title': 'Version',
  'version.subtitle': 'Welcher Build auf diesem Gerät läuft — und ob der Server einen neueren hat.',
  'version.device': 'Dieses Gerät',
  'version.server': 'Server',
  'version.status': 'Status',
  'version.reading': 'lese /health…',
  'version.serverUnknown': 'nicht gemeldet',
  'version.serverOffline': 'antwortet nicht',
  'version.check': 'Nach Updates suchen',
  'version.checking': 'Suche…',
  'version.downloading': 'neue Version wird geladen…',
  'version.ready': 'eine neue Version ist bereit — neu laden, um sie zu nutzen',
  'version.behind': 'der Server hat einen neueren Build als dieses Gerät',
  'version.offline': 'Server antwortet nicht — kein Vergleich möglich',
  'version.upToDate': 'aktuell',
  'version.checked': 'geprüft {time}',
  'version.unsupported':
    'Kein Service Worker hier — ein normales Neuladen holt immer den neuesten Build.',
  'version.reload': 'Jetzt neu laden',
}

const ru: Dictionary = {
  'home.nav': 'Всё в приложении',
  'home.section.money': 'Деньги',
  'home.section.together': 'Время вместе',
  'home.section.us': 'Друг о друге',
  'home.section.app': 'Приложение',

  // The commons (ADR-003)
  'commons.nav': 'Общее',
  'commons.tonight': 'Сегодня вечером',
  'commons.places': 'Места',
  'commons.ideas': 'Идеи',
  'commons.rate': 'Оценить место',
  'tonight.lede': 'Три вечера, которые сработали у других. Выберите один или ни одного.',
  'tonight.budget': 'Не дороже, на человека',
  'tonight.any': 'Любая',
  'tonight.empty': 'Пока нечего предложить.',
  'tonight.emptyHint':
    'Место появляется здесь, когда его оценили три дома. Оцените место, которое вам нравится, и список начнёт наполняться — включая ваше.',
  'tonight.footnote': 'Выдано на сегодня. Завтра будут другие.',
  'places.empty': 'Рядом пока ничего нет.',
  'places.emptyFiltered': 'Рядом ничего не подходит.',
  'places.emptyHint':
    'Место появляется, когда его оценили три дома — достаточно, чтобы нельзя было узнать ни один из них. Оцените место, которое вам нравится.',
  'places.everything': 'Всё',
  'ideas.ledeDo': 'Занятия, для которых не нужна ни бронь, ни база.',
  'ideas.ledeGive': 'Подарки, которые не сертификат.',
  'ideas.toDo': 'Чем заняться',
  'ideas.toGive': 'Что подарить',
  'tile.tonight.label': 'Сегодня вечером',
  'tile.tonight.value': 'Три',
  'tile.tonight.caption': 'вечера, которые сработали',

  // Shell
  'app.tagline': 'Планирование свиданий для дома',
  'nav.home': 'Главная',
  'nav.scan': 'Скан',
  'nav.expenses': 'Расходы',
  'nav.events': 'События',
  'nav.memories': 'Воспоминания',
  'nav.more': 'Ещё',
  'shell.signout': 'Выйти',
  'shell.signingout': 'Выходим…',
  'shell.switcher.title': 'Кто сейчас смотрит?',

  // Home tiles
  'tile.scan.label': 'Скан',
  'tile.scan.hint': 'Сфотографируй чек',
  // Кошелёк, Танцы и «О чём думаешь» — CONTRACTS §16–§19.
  'tile.wallet.label': 'Кошелёк',
  'tile.wallet.hint': 'Баллы и привязанные карты',
  'tile.wallet.value': 'Баллы',
  'tile.wallet.caption': 'и карты',
  'tile.dance.label': 'Танцы',
  'tile.dance.hint': 'Разучить движение вместе',
  'tile.dance.value': 'Четыре',
  'tile.dance.caption': 'движения',
  'tile.reflect.label': 'О чём думаешь',
  'tile.reflect.hint': 'Записать, только для себя',
  'tile.reflect.value': 'Записать',
  'tile.reflect.caption': 'только для тебя',
  'tile.mood.label': 'Настроение',
  'tile.mood.hint': 'Как ты сегодня?',
  'tile.mood.value': 'Отметиться',
  'tile.mood.caption': 'две секунды',
  'tile.ledger.label': 'Расходы',
  'tile.ledger.hint': 'Проводки и платежи',
  'tile.events.label': 'События',
  'tile.events.hint': 'Поездки, вечера, планы',
  'tile.calendar.label': 'Календарь',
  'tile.calendar.hint': 'Что впереди',
  'tile.memories.label': 'Воспоминания',
  'tile.memories.hint': 'Наша лента времени',
  'tile.statement.label': 'Итоги',
  'tile.statement.hint': 'Год в одном письме',
  'tile.settings.label': 'Настройки',
  'tile.settings.hint': 'Люди, импорт, система',
  'tile.howItWorks.label': 'Как это устроено',
  'tile.howItWorks.hint': 'Классификатор, по-человечески',

  // Login
  'login.tagline': 'Планирование свиданий на двоих',
  'login.username': 'Имя входа',
  'login.password': 'Пароль',
  'login.submit': 'Войти',
  'login.working': 'Входим…',

  // Mood
  'mood.title': 'Настроение',
  'mood.hint.named': 'Как дела у {name}? Нажми на лицо — или дай камере угадать.',
  'mood.hint.today': 'Как проходит день? Нажми на лицо — или дай камере угадать.',
  'mood.level.1': 'Тяжко',
  'mood.level.2': 'Так себе',
  'mood.level.3': 'Норм',
  'mood.level.4': 'Хорошо',
  'mood.level.5': 'Отлично',
  'mood.note.placeholder': 'Пара слов, если хочется (необязательно)',
  'mood.save': 'Сохранить',
  'mood.saving': 'Сохраняем…',
  'mood.scan': 'Скан лица',
  'mood.scanning': 'Смотрим…',
  'mood.privacy': 'Фото анализируется и сразу удаляется — сохраняется только оценка.',
  'mood.detection.off':
    'Распознавание лица выключено — на сервере нет ключа ИИ. Кнопки выше работают и без него.',
  'mood.saved': 'Сохранено. Возвращайся, когда погода переменится.',
  'mood.lately': 'Недавнее',
  'mood.empty':
    'Пока пусто. Первая запись — две секунды; картина года складывается из трёхсот таких.',
  'mood.camera.read': 'Камера увидела: {label}',

  // Scan
  'scan.title': 'Скан',
  'scan.hint': 'Сфотографируй чек. Document AI прочитает, классификатор разложит, ты подтвердишь.',
  'scan.mock':
    'Демо-извлечение — данные Document AI не настроены, суммы взяты из образца, а не из твоего фото. Проверь каждое поле перед проводкой.',

  // Settings
  'settings.title': 'Настройки',
  'settings.language.title': 'Язык',
  'settings.language.subtitle': 'Для этого устройства. Три на выбор; числа остаются швейцарскими.',
  'settings.session.title': 'Сессия',
  'settings.session.subtitle': 'Кто здесь вошёл — и как выйти.',
  'settings.session.signedInAs':
    'Вы вошли как {name}. Сессия живёт неделю, только в этом браузере.',
  'settings.session.anonymous': 'В этом браузере есть сессия.',

  // Version & updates
  'update.ready': 'Готова новая версия.',
  'update.reload': 'Обновить',
  'update.reloading': 'Перезагрузка…',
  'update.later': 'Позже',
  'version.title': 'Версия',
  'version.subtitle': 'Какая сборка стоит на этом устройстве — и есть ли на сервере новее.',
  'version.device': 'Это устройство',
  'version.server': 'Сервер',
  'version.status': 'Статус',
  'version.reading': 'читаем /health…',
  'version.serverUnknown': 'не сообщается',
  'version.serverOffline': 'не отвечает',
  'version.check': 'Проверить обновления',
  'version.checking': 'Проверяем…',
  'version.downloading': 'загружаем новую версию…',
  'version.ready': 'новая версия готова — обновите, чтобы перейти на неё',
  'version.behind': 'на сервере сборка новее, чем на этом устройстве',
  'version.offline': 'сервер не отвечает — сравнить не с чем',
  'version.upToDate': 'актуально',
  'version.checked': 'проверено {time}',
  'version.unsupported':
    'Здесь нет сервис-воркера — обычная перезагрузка всегда берёт свежую сборку.',
  'version.reload': 'Обновить сейчас',
}

const DICTIONARIES: Record<Lang, Dictionary> = { en: {}, de, ru }

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(LANG_KEY)
    if (stored === 'en' || stored === 'de' || stored === 'ru') return stored
  } catch {
    /* private mode; fall through to the guess */
  }
  const guess = (navigator.language ?? 'en').toLowerCase()
  if (guess.startsWith('de')) return 'de'
  if (guess.startsWith('ru')) return 'ru'
  return 'en'
}

function interpolate(text: string, values?: Record<string, string>): string {
  if (values === undefined) return text
  let out = text
  for (const [slot, value] of Object.entries(values)) out = out.replaceAll(`{${slot}}`, value)
  return out
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  /** `values` fills `{name}`-style slots after the lookup, so word order stays free. */
  t: (key: string, fallback: string, values?: Record<string, string>) => string
}

/**
 * The no-provider default still interpolates `{slots}`: a component rendered outside the
 * provider (a unit test, a storybook, an error boundary) must degrade to finished English
 * sentences, not to templates with the braces showing.
 */
const I18nContext = createContext<I18n>({
  lang: 'en',
  setLang: () => {},
  t: (_key, fallback, values) => interpolate(fallback, values),
})

export function useI18n(): I18n {
  return useContext(I18nContext)
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang())

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(LANG_KEY, next)
    } catch {
      /* the choice simply does not survive a restart */
    }
  }, [])

  // Screen readers and the browser's own translation prompt both read `<html lang>`. An
  // effect rather than a line in `setLang`, so a *stored* choice is stamped on the first
  // render too — otherwise a Russian-speaking device reloads into `lang="en"` and Chrome
  // offers to translate a page that is already in Russian.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const t = useCallback(
    (key: string, fallback: string, values?: Record<string, string>): string => {
      return interpolate(DICTIONARIES[lang][key] ?? fallback, values)
    },
    [lang],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
