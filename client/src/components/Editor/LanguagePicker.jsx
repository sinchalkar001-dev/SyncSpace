import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES } from '../../lib/languages.js'
import { useUIStore } from '../../store/uiStore.js'
import { useDismissable } from '../../hooks/useDismissable.js'
import { Icon } from '../ui/Icon.jsx'

/**
 * Ranks a search: the exact name first, then names that start with what was
 * typed, then the rest.
 *
 * Without this, "java" listed javascript above java — first in the list and
 * first for Enter — so asking for one language and being given another was a
 * single keystroke away.
 */
const score = (name, needle) => (name === needle ? 0 : name.startsWith(needle) ? 1 : 2)

const byRelevance = (needle) => (a, b) => score(a, needle) - score(b, needle)

/** Only languages Monaco is actually configured for ever appear here. */
export function LanguagePicker() {
  const language = useUIStore((s) => s.language)
  const setLanguage = useUIStore((s) => s.setLanguage)
  const recent = useUIStore((s) => s.recentLanguages)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const inputRef = useRef(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useDismissable(open, close, { containerRef, triggerRef })

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = needle ? LANGUAGES.filter((name) => name.includes(needle)).sort(byRelevance(needle)) : LANGUAGES
    if (needle) return all

    // No query: surface what this person actually uses, then the rest.
    const recentlyUsed = recent.filter((name) => LANGUAGES.includes(name))
    return [...recentlyUsed, ...all.filter((name) => !recentlyUsed.includes(name))]
  }, [query, recent])

  const choose = (name) => {
    setLanguage(name)
    close()
    triggerRef.current?.focus()
  }

  return (
    <div className="langpicker" ref={containerRef}>
      <button
        type="button"
        className="langpicker__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={'Editor language: ' + language}
        ref={triggerRef}
      >
        <Icon name="code" size={13} />
        <span>{language}</span>
        <Icon name="chevronDown" size={11} />
      </button>

      {open && (
        <div className="popover popover--anchored langpicker__panel" role="listbox">
          <input
            ref={inputRef}
            className="langpicker__search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search languages"
            aria-label="Search languages"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches.length) choose(matches[0])
            }}
          />

          <div className="langpicker__list">
            {matches.map((name, index) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === language}
                className={'langpicker__item' + (name === language ? ' is-active' : '')}
                onClick={() => choose(name)}
              >
                <span>{name}</span>
                {!query && index < recent.length && <span className="langpicker__tag">recent</span>}
              </button>
            ))}

            {matches.length === 0 && <p className="langpicker__empty">No language matches that.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
