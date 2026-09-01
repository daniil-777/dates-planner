/*
 * The language, chosen where the theme is chosen — as a device preference.
 *
 * Three buttons rather than a dropdown: there are three options, they all fit on one row,
 * and each is written in its own language, because "Russian" is only legible to somebody
 * who does not need the button. English is the fallback everywhere, so switching is safe
 * mid-anything — a screen that is not fully translated yet degrades to English sentences,
 * never to key names or blanks.
 */
import { LANGUAGES, useI18n } from '@/i18n'
import { SettingsCard } from './SettingsCard'

export function LanguageCard() {
  const { lang, setLang, t } = useI18n()

  return (
    <SettingsCard
      icon="world"
      title={t('settings.language.title', 'Language')}
      subtitle={t(
        'settings.language.subtitle',
        'For this device. Three to choose from; the numbers stay Swiss either way.',
      )}
    >
      <div className="twm-lang" role="radiogroup" aria-label={t('settings.language.title', 'Language')}>
        {LANGUAGES.map(option => (
          <button
            key={option.code}
            type="button"
            role="radio"
            aria-checked={lang === option.code}
            lang={option.code}
            className={lang === option.code ? 'twm-lang__option twm-lang__option--active' : 'twm-lang__option'}
            onClick={() => setLang(option.code)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </SettingsCard>
  )
}

export default LanguageCard
