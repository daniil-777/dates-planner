/*
 * The translation mechanism, not the translations.
 *
 * What must hold whatever the dictionaries say: English is the fallback and never a key
 * name, `{slots}` interpolate in every language and outside the provider too, and the
 * choice both persists and stamps `<html lang>` — screen readers and the browser's own
 * translate prompt read that attribute.
 */
import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { I18nProvider, LANG_KEY, useI18n } from './index'

function Probe() {
  const { lang, setLang, t } = useI18n()
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="known">{t('nav.expenses', 'Expenses')}</span>
      <span data-testid="unknown">{t('no.such.key', 'the English sentence')}</span>
      <span data-testid="slot">{t('mood.camera.read', 'Camera read: {label}', { label: 'content' })}</span>
      <button type="button" onClick={() => setLang('ru')}>
        ru
      </button>
    </div>
  )
}

describe('i18n', () => {
  it('falls back to the English sentence, never the key', () => {
    window.localStorage.setItem(LANG_KEY, 'de')
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )
    expect(screen.getByTestId('known').textContent).toBe('Ausgaben')
    expect(screen.getByTestId('unknown').textContent).toBe('the English sentence')
  })

  it('interpolates slots in a translated string', () => {
    window.localStorage.setItem(LANG_KEY, 'ru')
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )
    expect(screen.getByTestId('slot').textContent).toBe('Камера увидела: content')
  })

  it('persists the choice and stamps the document language', () => {
    window.localStorage.setItem(LANG_KEY, 'en')
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )
    act(() => screen.getByText('ru').click())
    expect(screen.getByTestId('lang').textContent).toBe('ru')
    expect(window.localStorage.getItem(LANG_KEY)).toBe('ru')
    expect(document.documentElement.lang).toBe('ru')
  })

  it('interpolates even outside the provider, so nothing renders {braces}', () => {
    window.localStorage.removeItem(LANG_KEY)
    render(<Probe />)
    expect(screen.getByTestId('slot').textContent).toBe('Camera read: content')
    expect(screen.getByTestId('unknown').textContent).toBe('the English sentence')
  })
})
