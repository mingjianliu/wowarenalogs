import { useCallback, useState } from 'react';

function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportButtons({ markdown, filename }: { markdown: string; filename: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    navigator.clipboard
      .writeText(markdown)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => {
        // clipboard permission denied (some web contexts) — fall back to the file download
        downloadMarkdown(markdown, filename);
      });
  }, [markdown, filename]);

  return (
    <div className="flex flex-row gap-2">
      <button className={`btn btn-xs ${copied ? 'btn-success' : 'btn-ghost'}`} onClick={onCopy}>
        {copied ? 'Copied' : 'Copy Markdown'}
      </button>
      <button className="btn btn-xs btn-ghost" onClick={() => downloadMarkdown(markdown, filename)}>
        Save .md
      </button>
    </div>
  );
}
