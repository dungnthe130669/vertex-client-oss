import { useEffect, useState } from "preact/hooks";
import { type ArtifactType, getArtifact } from "./api";
import { InlineSvg } from "./svg-inline";
import { IconCode, IconDoc, IconImage } from "./icons";
import { type ArtifactRef, TYPE_LABEL, latestArtifactVersion, noteArtifactVersion, subscribeArtifactVersions } from "./artifacts-logic";

// Split out of artifacts.tsx so the chat (which renders the card) does not pull the whole gallery/viewer screen into the main bundle.
const open = (id: string) => { history.pushState({ fromApp: true }, "", `/artifacts/${id}`); dispatchEvent(new PopStateEvent("popstate")); };

/** In-chat chip for a create/update_artifact result: title, type, version, Open. */
const TypeIcon = ({ type }: { type: ArtifactRef["type"] }) => (type === "code" || type === "html" ? <IconCode /> : type === "svg" ? <IconImage /> : <IconDoc />);
export function ArtifactCard({ id, title, type, version }: { id: string; title: string; type: ArtifactType; version: number }) {
  // Every card for the same artifact shows the newest version seen in this chat, so an update_artifact bumps the earlier card in place.
  const [, tick] = useState(0);
  useEffect(() => { noteArtifactVersion(id, version); return subscribeArtifactVersions(() => tick((x) => x + 1)); }, [id, version]);
  const v = latestArtifactVersion(id, version);
  // An svg artifact also shows its picture inline (fetched per version; a failed fetch leaves just the card).
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (type !== "svg") return;
    let live = true;
    void getArtifact(id, v).then((r) => { if (live && r.status === 200 && typeof r.data?.content === "string") setSvg(r.data.content); }).catch(() => {});
    return () => { live = false; };
  }, [id, v, type]);
  return (<>
    {svg !== null && <InlineSvg source={svg} title={title} onOpen={() => open(id)} />}
    <div class="artcard" data-testid="artifact-card" data-version={v}>
      <span class="artcard-ic" data-testid="artifact-card-icon" data-type={type}><TypeIcon type={type} /></span>
      <span class="artcard-main"><strong class="ellip">{title}</strong><span class="muted small" data-testid="artifact-card-meta">{TYPE_LABEL[type]} · v{v}</span></span>
      <button class="btn" data-testid="artifact-open" aria-label={`Open ${title}`} onClick={() => open(id)}>Open</button>
    </div>
  </>);
}
