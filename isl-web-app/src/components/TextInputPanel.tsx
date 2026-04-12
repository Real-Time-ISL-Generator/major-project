import {useRef, useState} from 'react';

type Props = {
  onSubmit: (submission: {
    text: string;
    videoUrl: string;
    fileContent: string;
  }) => Promise<void>;
  onClear: () => void;
};

export function TextInputPanel({onSubmit, onClear}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (loading) return;

    if (!text.trim() && !videoUrl.trim() && !fileContent.trim()) {
      alert('Add typed text, upload a subtitle file, or paste a YouTube link.');
      return;
    }

    try {
      setLoading(true);
      await onSubmit({
        text: text.trim(),
        videoUrl: videoUrl.trim(),
        fileContent,
      });
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

  return (
    <div className="control-strip">
      <textarea
        className="control-textarea"
        placeholder="Type text to sign"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <input ref={fileInputRef} type="file" accept=".srt,.vtt" onChange={handleFileUpload} />

      <input
        type="text"
        placeholder="Paste YouTube link"
        value={videoUrl}
        onChange={(e) => setVideoUrl(e.target.value)}
      />

      <button onClick={handleSubmit}>
        {loading ? 'Processing...' : 'Submit'}
      </button>

      <button type="button" className="button-clear" onClick={handleClear} disabled={loading}>
        Clear
      </button>

      {fileName ? <p className="control-file-name">Loaded file: {fileName}</p> : null}
    </div>
  );
}
