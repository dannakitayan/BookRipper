import { useEffect, useState } from 'react'
import { api, type Health } from './api'

export default function Settings({
  health,
  onRefreshHealth,
  onDone,
}: {
  health: Health | null
  onRefreshHealth: () => void
  onDone: () => void
}) {
  const [filterModel, setFilterModel] = useState('')
  const [synthModel, setSynthModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (health) {
      setFilterModel(health.filter_model)
      setSynthModel(health.synth_model)
    }
  }, [health])

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.updateSettings(filterModel, synthModel)
      setSaved(true)
      onRefreshHealth()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }

  const ollamaDown = health !== null && !health.ollama_reachable

  return (
    <div className="library-overlay" onClick={onDone}>
      <div className="library" onClick={(e) => e.stopPropagation()}>
        <div className="library__head">
          <h2>AI settings</h2>
          <button className="library__close" onClick={onDone}>×</button>
        </div>

        <div className="library__section">
          <h3>Connection</h3>
          {!health ? (
            <div className="settings__status settings__status--bad">
              <strong>Backend server is not running.</strong>
              <p>
                Start it (e.g. <code>uvicorn bookripper.app:app --port 8008</code> from{' '}
                <code>Server/</code>, or run the desktop app which starts it for you) and retry.
              </p>
            </div>
          ) : !health.ollama_reachable ? (
            <div className="settings__status settings__status--bad">
              <strong>Ollama is not reachable at {health.ollama}.</strong>
              <p>{health.ollama_error ?? 'Start Ollama and retry.'}</p>
            </div>
          ) : !health.embed_ready ? (
            <div className="settings__status settings__status--warn">
              <strong>Embedding model "{health.embed_model}" is not pulled.</strong>
              <p>
                Run <code>ollama pull {health.embed_model}</code> — search won't work without it.
              </p>
            </div>
          ) : (
            <div className="settings__status settings__status--ok">
              Connected — Ollama reachable, embedding model ready.
            </div>
          )}
          <button onClick={onRefreshHealth}>recheck connection</button>
        </div>

        <div className="library__section">
          <h3>Models</h3>
          {!health ? (
            <p className="library__hint">Models can't be read until the backend is reachable.</p>
          ) : (
            <>
              <label className="settings__field">
                <span>
                  Embedding model <span className="library__hint">(fixed — changing it needs re-indexing)</span>
                </span>
                <input value={health.embed_model} disabled />
              </label>

              <label className="settings__field">
                <span>Filter model — decides which excerpts answer the question</span>
                {health.models.length ? (
                  <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
                    {!health.models.includes(filterModel) && filterModel && (
                      <option value={filterModel}>{filterModel} (not installed)</option>
                    )}
                    {health.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={filterModel} onChange={(e) => setFilterModel(e.target.value)} disabled={ollamaDown} />
                )}
              </label>

              <label className="settings__field">
                <span>Synthesis model — writes the summary of kept excerpts</span>
                {health.models.length ? (
                  <select value={synthModel} onChange={(e) => setSynthModel(e.target.value)}>
                    {!health.models.includes(synthModel) && synthModel && (
                      <option value={synthModel}>{synthModel} (not installed)</option>
                    )}
                    {health.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={synthModel} onChange={(e) => setSynthModel(e.target.value)} disabled={ollamaDown} />
                )}
              </label>

              {error && <p className="library__error">{error}</p>}
              <div className="settings__actions">
                <button onClick={save} disabled={saving || !filterModel.trim() || !synthModel.trim()}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="settings__saved">Saved.</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
