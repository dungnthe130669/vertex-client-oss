import { useEffect, useMemo, useState } from "preact/hooks";
import { IconCopy, IconDownload } from "./icons";
import { copyText } from "./msg-actions";
import { checkSvg, ensureXmlns, wellFormed, type SvgVerdict } from "./svg-safe";

/** One stable stand-in for a svg still being written (never partial markup). */
export function SvgPending() {
  return <div class="svginline pending skel" role="status" aria-busy="true" data-testid="svg-pending"><span class="muted small">Drawing image…</span></div>;
}

/** A downloaded/copied-source action pair shared with the artifact viewer's download mechanism (<a download> on a blob, never navigated to). */
export function downloadSvg(source: string, title: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
  const l = document.createElement("a");
  l.href = url; l.download = `${(title || "image").replace(/[^\w.-]+/g, "_").slice(0, 60) || "image"}.svg`; l.rel = "noopener"; document.body.append(l); l.click(); l.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SVG shown inline in a message. Only ever `<img src=blob:>` (no script runs, markup never enters the DOM). Unsafe markup is NOT rendered: a code card + note instead. */
export function InlineSvg({ source, title, onOpen }: { source: string; title: string; onOpen?: () => void }) {
  const fixed = useMemo(() => ensureXmlns(source), [source]);
  const verdict = useMemo((): SvgVerdict => { const v = checkSvg(source); return v.ok ? wellFormed(fixed) : v; }, [source, fixed]);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [source]);
  const url = useMemo(() => (verdict.ok ? URL.createObjectURL(new Blob([fixed], { type: "image/svg+xml" })) : null), [fixed, verdict.ok]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url || loadFailed) return (
    <div class="svginline unsafe" data-testid="svg-unsafe">
      <p class="muted small" role="note">Not rendered: {loadFailed ? "the image could not be loaded" : verdict.ok ? "unsafe content" : verdict.reason}</p>
      <div class="codeblock"><pre><code>{source.slice(0, 20000)}</code></pre></div>
    </div>);
  const img = <img src={url} alt={title} data-testid="svg-inline-img" onError={() => setLoadFailed(true)} />;
  return (
    <figure class="svginline" data-testid="svg-inline">
      {onOpen
        ? <button type="button" class="svginline-open" aria-label={`Open ${title} in the viewer`} data-testid="svg-inline-open" onClick={onOpen}>{img}</button>
        : <div class="svginline-open">{img}</div>}
      <figcaption class="svginline-bar">
        <span class="muted small ellip">{title}</span>
        <button type="button" class="ghost" data-testid="svg-download" onClick={() => downloadSvg(source, title)}><IconDownload /><span>Download .svg</span></button>
        <button type="button" class="ghost" data-testid="svg-copy" onClick={() => copyText(source, "SVG source copied")}><IconCopy /><span>Copy source</span></button>
      </figcaption>
    </figure>
  );
}
