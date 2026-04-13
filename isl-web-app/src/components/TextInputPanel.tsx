import {useEffect, useId, useRef, useState} from 'react';

type Props = {
  onSubmit: (submission: {
    text: string;
    videoUrl: string;
    fileContent: string;
  }) => Promise<void>;
  onClear: () => void;
};

type InputMode = 'youtube' | 'text' | 'file';
type ThemeMode = 'light' | 'dark';

function ActionIcon({children}: {children: React.ReactNode}) {
  return <span className="icon-button-glyph" aria-hidden="true">{children}</span>;
}

export function TextInputPanel({onSubmit, onClear}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputId = useId();
  const [activeMode, setActiveMode] = useState<InputMode>('youtube');
  const [text, setText] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');

  useEffect(() => {
    const storedTheme = window.localStorage.getItem('theme-mode');
    const rootTheme = document.documentElement.dataset.theme;
    const initialTheme =
      storedTheme === 'dark' || storedTheme === 'light'
        ? storedTheme
        : rootTheme === 'dark'
          ? 'dark'
          : 'light';

    setThemeMode(initialTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem('theme-mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMenuOpen]);

  const handleSubmit = async () => {
    if (loading) {
      return;
    }

    const nextSubmission =
      activeMode === 'text'
        ? {
            text: text.trim(),
            videoUrl: '',
            fileContent: '',
          }
        : activeMode === 'file'
          ? {
              text: '',
              videoUrl: '',
              fileContent,
            }
          : {
              text: '',
              videoUrl: videoUrl.trim(),
              fileContent: '',
            };

    if (!nextSubmission.text && !nextSubmission.videoUrl && !nextSubmission.fileContent) {
      alert('Add content to the active input mode before submitting.');
      return;
    }

    try {
      setLoading(true);
      await onSubmit(nextSubmission);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'Could not process the input.';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const content = await file.text();

    setFileName(file.name);
    setFileContent(content);
  };

  const handleClear = () => {
    setText('');
    setVideoUrl('');
    setFileName('');
    setFileContent('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClear();
  };

  const handleThemeToggle = () => {
    setThemeMode(currentTheme => (currentTheme === 'light' ? 'dark' : 'light'));
    setIsMenuOpen(false);
  };

  return (
    <div className="composer-card">
      <div className="workspace-toolbar">
        <div className="workspace-brand">
          <p className="workspace-kicker">ISL Translation Workspace</p>
          <p className="workspace-title">Sign Translation Studio</p>
        </div>
        <div className="composer-toolbar">
          <div className="mode-selector" role="tablist" aria-label="Input mode">
            {([
              ['youtube', 'YouTube URL'],
              ['text', 'Text'],
              ['file', 'Subtitle File'],
            ] as const).map(([mode, label]) => {
              const isActive = activeMode === mode;

              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={isActive ? 'mode-button mode-button-active' : 'mode-button'}
                  onClick={() => setActiveMode(mode)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="toolbar-menu" ref={menuRef}>
            <button
              type="button"
              className="menu-trigger"
              aria-label="Open workspace menu"
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              onClick={() => setIsMenuOpen(open => !open)}
            >
              <span className="icon-button-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M5 7h14" />
                  <path d="M5 12h14" />
                  <path d="M5 17h14" />
                </svg>
              </span>
            </button>

            {isMenuOpen ? (
              <div className="menu-dropdown" role="menu" aria-label="Workspace menu">
                <button type="button" className="menu-item menu-item-disabled" role="menuitem" disabled>
                  <span>Our Team</span>
                </button>
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={handleThemeToggle}
                >
                  <span>Toggle Theme</span>
                  <strong>{themeMode === 'light' ? 'Dark' : 'Light'}</strong>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="composer-workspace">
        {activeMode === 'youtube' ? (
          <div className="input-card input-card-compact">
            <div className="input-card-header">
              <label className="field-label" htmlFor="youtube-source">
                YouTube link
              </label>
            </div>
            <div className="input-stage">
              <div className="input-control-wrap">
                <input
                  id="youtube-source"
                  className="control-input control-input-fixed"
                  type="text"
                  placeholder="Enter a YouTube URL"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                />
              </div>
              <div className="action-rail">
                <button
                  type="button"
                  className="icon-button icon-button-primary"
                  aria-label={loading ? 'Processing' : 'Submit'}
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M5 12h12" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </ActionIcon>
                </button>
                <button
                  type="button"
                  className="icon-button icon-button-secondary"
                  aria-label="Clear"
                  onClick={handleClear}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M6 6l12 12" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </ActionIcon>
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeMode === 'text' ? (
          <div className="input-card input-card-compact">
            <div className="input-card-header">
              <label className="field-label" htmlFor="text-source">
                Text to sign
              </label>
            </div>
            <div className="input-stage">
              <div className="input-control-wrap">
                <textarea
                  id="text-source"
                  className="control-textarea control-textarea-fixed"
                  placeholder="Enter text for translation"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <div className="action-rail">
                <button
                  type="button"
                  className="icon-button icon-button-primary"
                  aria-label={loading ? 'Processing' : 'Submit'}
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M5 12h12" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </ActionIcon>
                </button>
                <button
                  type="button"
                  className="icon-button icon-button-secondary"
                  aria-label="Clear"
                  onClick={handleClear}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M6 6l12 12" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </ActionIcon>
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeMode === 'file' ? (
          <div className="input-card input-card-compact">
            <div className="input-card-header">
              <span className="field-label">Subtitle file</span>
            </div>
            <div className="input-stage">
              <div className="input-control-wrap">
                <label className="file-dropzone file-dropzone-fixed" htmlFor={fileInputId}>
                  <span className="file-dropzone-title">
                    {fileName ? 'Replace subtitle file' : 'Select a subtitle file'}
                  </span>
                  {fileName ? <span className="file-dropzone-copy">{`Loaded: ${fileName}`}</span> : null}
                </label>
              </div>
              <div className="action-rail">
                <button
                  type="button"
                  className="icon-button icon-button-primary"
                  aria-label={loading ? 'Processing' : 'Submit'}
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M5 12h12" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </ActionIcon>
                </button>
                <button
                  type="button"
                  className="icon-button icon-button-secondary"
                  aria-label="Clear"
                  onClick={handleClear}
                  disabled={loading}
                >
                  <ActionIcon>
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M6 6l12 12" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </ActionIcon>
                </button>
              </div>
            </div>
            <input
              id={fileInputId}
              ref={fileInputRef}
              className="file-input-hidden"
              type="file"
              accept=".srt,.vtt"
              onChange={handleFileUpload}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
